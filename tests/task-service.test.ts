import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, listTasks, removeTask, setTaskEnabled } from "../src/task-service.ts";
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
