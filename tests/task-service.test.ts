import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, exportTasks, importTasks, listTasks, removeTask, setTaskEnabled } from "../src/task-service.ts";
import { loadRegistry } from "../src/registry.ts";
import { importLegacyStore } from "../src/migration.ts";
import { saveTasks } from "../src/storage.ts";
import { schedulerPaths } from "../src/paths.ts";
import type { ScheduleTask } from "../src/types.ts";

/** Points AGENTS_CRON_HOME at a fresh temp home; restores it afterwards. */
async function withRegistryHome(): Promise<() => void> {
  const home = await mkdtemp(join(tmpdir(), "agents-cron-home-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  return () => {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
  };
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agents-cron-proj-"));
}

/** Intercepts real process.stderr — library warnings bypass the CLI's err sink. */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { text: () => chunks.join(""), restore: () => void (process.stderr.write = original) };
}

const NOW = new Date("2026-10-22T09:00:00.000Z");

test("enable, disable, and remove act on any project's task from any directory", async () => {
  const restore = await withRegistryHome();
  try {
    const owner = await project();
    const elsewhere = await project();
    const task = await addTask(owner, { prompt: "p", schedule: { kind: "interval", every: "5m" } }, NOW);

    const disabled = await setTaskEnabled(elsewhere, task.id, false);
    assert.equal(disabled.enabled, false);
    assert.equal((await loadRegistry())[0].enabled, false);

    await setTaskEnabled(elsewhere, task.id, true);
    await removeTask(elsewhere, task.id);
    assert.deepEqual(await loadRegistry(), []);
  } finally {
    restore();
  }
});

test("addTask persists notifyTo trimmed and deduplicated; absent stays absent", async () => {
  const restore = await withRegistryHome();
  try {
    const owner = await project();
    const routed = await addTask(
      owner,
      { prompt: "p", schedule: { kind: "interval", every: "5m" }, notifyTo: [" feishu ", "mail", "feishu", ""] },
      NOW,
    );
    assert.deepEqual(routed.notifyTo, ["feishu", "mail"]);
    assert.deepEqual((await loadRegistry())[0].notifyTo, ["feishu", "mail"]);

    // An empty list is the same as no routing: every configured channel.
    const bare = await addTask(owner, { prompt: "p", schedule: { kind: "interval", every: "5m" }, notifyTo: [] }, NOW);
    assert.equal("notifyTo" in bare, false);
  } finally {
    restore();
  }
});

test("addTask warns on stderr when notifyTo names ids the project never configured", async () => {
  const restore = await withRegistryHome();
  try {
    const owner = await project();
    const dir = schedulerPaths(owner).dir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ notifications: { channels: [{ id: "hook-a", type: "webhook", url: "https://example.test/hook" }] } }),
    );

    const stderr = captureStderr();
    try {
      const task = await addTask(
        owner,
        { prompt: "p", schedule: { kind: "interval", every: "5m" }, notifyTo: ["hook-a", "typo"] },
        NOW,
      );
      // A warning, not a rejection: the routing is still recorded.
      assert.deepEqual(task.notifyTo, ["hook-a", "typo"]);
    } finally {
      stderr.restore();
    }
    assert.match(stderr.text(), /no notification channel "typo"/);
    assert.doesNotMatch(stderr.text(), /"hook-a"/);
  } finally {
    restore();
  }
});

test("addTask warns for every routed id when the project has no channels configured", async () => {
  const restore = await withRegistryHome();
  try {
    const owner = await project(); // no .agents/cron/config.json at all
    const stderr = captureStderr();
    try {
      await addTask(owner, { prompt: "p", schedule: { kind: "interval", every: "5m" }, notifyTo: ["mac"] }, NOW);
    } finally {
      stderr.restore();
    }
    assert.match(stderr.text(), /no notification channel "mac"/);
  } finally {
    restore();
  }
});

test("any task command on a legacy project imports its store into the registry", async () => {
  const restore = await withRegistryHome();
  try {
    const legacyProject = await project();
    await saveTasks(schedulerPaths(legacyProject).tasksFile, [
      {
        id: "task_old00001",
        prompt: "legacy duty",
        schedule: { kind: "interval", everyMs: 600_000 },
        enabled: true,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:00:00.000Z",
      },
    ]);

    const tasks: ScheduleTask[] = await listTasks(legacyProject);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].projectDir, legacyProject);
    assert.ok(!existsSync(schedulerPaths(legacyProject).tasksFile));
  } finally {
    restore();
  }
});

test("importLegacyStore stays a no-op for projects without a legacy store", async () => {
  const restore = await withRegistryHome();
  try {
    const fresh = await project();
    await importLegacyStore(fresh);
    assert.deepEqual(await loadRegistry(), []);
    assert.ok(!existsSync(schedulerPaths(fresh).dir));
  } finally {
    restore();
  }
});

test("addTask stores the task in the global registry, bound to the project", async () => {
  const restore = await withRegistryHome();
  try {
    const cwd = await project();

    const task = await addTask(cwd, { prompt: "check CI", schedule: { kind: "interval", every: "5m" } }, NOW);

    const registry = await loadRegistry();
    assert.equal(registry.length, 1);
    assert.equal(registry[0].id, task.id);
    assert.equal(registry[0].projectDir, cwd);
    // The project store never gains a tasks.json — definitions are registry-only.
    assert.ok(!existsSync(schedulerPaths(cwd).tasksFile));
  } finally {
    restore();
  }
});

test("listTasks orders the project view: local first, then other projects by path", async () => {
  const restore = await withRegistryHome();
  try {
    const parent = await mkdtemp(join(tmpdir(), "agents-cron-projects-"));
    const local = join(parent, "local");
    const otherA = join(parent, "other-a");
    const otherB = join(parent, "other-b");
    await Promise.all([local, otherA, otherB].map((dir) => mkdir(dir, { recursive: true })));
    // Registry order is deliberately unfavourable: others first.
    await addTask(otherB, { prompt: "b1", schedule: { kind: "interval", every: "5m" } }, NOW);
    await addTask(otherA, { prompt: "a2", schedule: { kind: "interval", every: "5m" } },
      new Date("2026-10-22T09:05:00.000Z"));
    await addTask(otherA, { prompt: "a1", schedule: { kind: "interval", every: "5m" } }, NOW);
    await addTask(local, { prompt: "l2", schedule: { kind: "interval", every: "5m" } },
      new Date("2026-10-22T09:05:00.000Z"));
    await addTask(local, { prompt: "l1", schedule: { kind: "interval", every: "5m" } }, NOW);

    const tasks: ScheduleTask[] = await listTasks(local);

    assert.deepEqual(
      tasks.map((task) => [task.prompt, task.projectDir === local ? "local" : task.projectDir === otherA ? "A" : "B"]),
      [
        ["l1", "local"], // local first, within group by nextRunAt
        ["l2", "local"],
        ["a1", "A"], // then others by project path A→Z…
        ["a2", "A"],
        ["b1", "B"],
      ].map(([prompt, tag]) => [prompt, tag]),
    );
  } finally {
    restore();
  }
});

// --- Task export and import (ADR 0009) ---

test("exportTasks keeps the current project's definitions only, unless all", async () => {
  const restore = await withRegistryHome();
  try {
    const local = await project();
    const other = await project();
    const localTask = await addTask(local, { prompt: "local p", name: "watch", schedule: { kind: "interval", every: "5m" } }, NOW);
    await addTask(other, { prompt: "other p", schedule: { kind: "interval", every: "5m" } }, NOW);

    const localFile = await exportTasks(local, {}, NOW);
    assert.deepEqual(localFile.tasks.map((task) => task.prompt), ["local p"]);
    assert.equal("id" in localFile.tasks[0], false);
    assert.equal("projectDir" in localFile.tasks[0], false);
    assert.equal(localFile.tasks[0].name, "watch");

    const allFile = await exportTasks(local, { all: true }, NOW);
    assert.deepEqual(allFile.tasks.map((task) => task.prompt).sort(), ["local p", "other p"]);

    const picked = await exportTasks(local, { ids: [localTask.id] }, NOW);
    assert.deepEqual(picked.tasks.map((task) => task.prompt), ["local p"]);
  } finally {
    restore();
  }
});

test("importTasks rebinds to the importing project: new ids, disabled, fresh nextRunAt", async () => {
  const restore = await withRegistryHome();
  try {
    const source = await project();
    const target = await project();
    const sourceTask = await addTask(source, { prompt: "p", schedule: { kind: "interval", every: "5m" }, name: "watch" }, NOW);
    const file = await exportTasks(source, {}, NOW);

    const report = await importTasks(target, file.tasks, { now: new Date("2026-10-28T09:00:00.000Z") });

    assert.equal(report.created.length, 1);
    const imported = report.created[0];
    assert.notEqual(imported.id, sourceTask.id); // a fresh id, never the exported identity
    assert.equal(imported.name, "watch");
    assert.equal(imported.projectDir, target);
    assert.equal(imported.enabled, false);
    assert.equal(imported.nextRunAt, "2026-10-28T09:05:00.000Z");
    assert.equal(imported.createdAt, "2026-10-28T09:00:00.000Z");
    // Registry state does not travel: no counters from the source task.
    assert.equal(imported.successCount, undefined);
    // Export copies, never moves: the source task stays put alongside the import.
    assert.deepEqual((await loadRegistry()).map((task) => task.projectDir).sort(), [source, target].sort());
  } finally {
    restore();
  }
});

test("importTasks skips an entry only when name, prompt, and schedule all match", async () => {
  const restore = await withRegistryHome();
  try {
    const project1 = await project();
    const interval5 = { kind: "interval", everyMs: 300_000 } as const;
    await addTask(project1, { prompt: "p", name: "watch", schedule: { kind: "interval", every: "5m" } }, NOW);

    const report = await importTasks(project1, [
      { prompt: "p", name: "watch", schedule: interval5 },          // all three match: skipped
      { prompt: "p", name: "other", schedule: interval5 },          // different name: created
      { prompt: "p", name: "watch", schedule: { kind: "interval", everyMs: 600_000 } }, // different schedule: created
    ], { now: NOW });

    assert.equal(report.created.length, 2);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /duplicate/);
  } finally {
    restore();
  }
});

test("importTasks warns about unknown channels and past once schedules without blocking", async () => {
  const restore = await withRegistryHome();
  try {
    const project1 = await project();
    const report = await importTasks(project1, [
      { prompt: "p", schedule: { kind: "once", runAt: "2026-10-01T00:00:00.000Z" }, notifyTo: ["feishu"] },
    ], { now: NOW });

    assert.equal(report.created.length, 1);
    assert.equal(report.warnings.length, 2);
    assert.match(report.warnings.join("\n"), /channel "feishu"/);
    assert.match(report.warnings.join("\n"), /in the past/);
  } finally {
    restore();
  }
});

test("importTasks dry-run previews without writing the registry", async () => {
  const restore = await withRegistryHome();
  try {
    const project1 = await project();
    const report = await importTasks(project1, [{ prompt: "p", schedule: { kind: "interval", everyMs: 300_000 } }], { now: NOW, dryRun: true });

    assert.equal(report.created.length, 1);
    assert.deepEqual(await loadRegistry(), []);
  } finally {
    restore();
  }
});
