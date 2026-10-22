import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, saveRegistry, updateRegistry } from "../src/registry.ts";
import { importLegacyStore } from "../src/migration.ts";
import { saveTasks } from "../src/storage.ts";
import { registryPaths, schedulerPaths } from "../src/paths.ts";
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

export function registryTask(id = "task_test"): ScheduleTask {
  return {
    id,
    projectDir: "/home/user/proj",
    name: "test",
    prompt: "check status",
    schedule: { kind: "interval", everyMs: 300_000 },
    enabled: true,
    nextRunAt: "2026-09-01T10:05:00.000Z",
    lastRunAt: "2026-09-01T10:05:41.000Z",
    lastStatus: "success",
    successCount: 1,
    errorCount: 0,
    missedCount: 0,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:05:41.000Z",
  };
}

test("the registry rejects a version 1 file and tasks without a project binding", async () => {
  const restore = await withRegistryHome();
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const file = registryPaths().tasksFile;
    await mkdir(registryPaths().dir, { recursive: true });
    const v1 = registryTask();
    delete (v1 as Partial<ScheduleTask>).projectDir;
    await writeFile(file, JSON.stringify({ version: 1, tasks: [v1] }));
    await assert.rejects(loadRegistry(), /Unsupported task registry format/);

    await writeFile(file, JSON.stringify({ version: 2, tasks: [v1] }));
    await assert.rejects(loadRegistry(), /Malformed task in registry/);
    await assert.rejects(saveRegistry([v1]), /Refusing to save malformed task/);
  } finally {
    restore();
  }
});

test("a corrupt registry file is backed up before the error surfaces", async () => {
  const restore = await withRegistryHome();
  try {
    const { writeFile, readdir, mkdir } = await import("node:fs/promises");
    const file = registryPaths().tasksFile;
    await mkdir(registryPaths().dir, { recursive: true });
    await writeFile(file, "{ not json");

    await assert.rejects(loadRegistry(), /Invalid task registry/);
    const backups = (await readdir(registryPaths().dir)).filter((name) =>
      name.startsWith("tasks.json.corrupt."),
    );
    assert.equal(backups.length, 1);
  } finally {
    restore();
  }
});

test("a legacy project store is imported into the registry and renamed aside", async () => {
  const restore = await withRegistryHome();
  try {
    const project = await mkdtemp(join(tmpdir(), "agents-cron-proj-"));
    const paths = schedulerPaths(project);
    await mkdir(join(paths.runsDir), { recursive: true });
    const legacy = {
      id: "task_legacy01",
      name: "legacy",
      prompt: "old task",
      schedule: { kind: "interval" as const, everyMs: 600_000 },
      enabled: true,
      nextRunAt: "2026-09-01T10:10:00.000Z",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    };
    await saveTasks(paths.tasksFile, [legacy]);
    await writeFile(join(paths.runsDir, "run_1.json"), "{}");

    await importLegacyStore(project);

    // Imported with the binding backfilled…
    const tasks = await loadRegistry();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "task_legacy01");
    assert.equal(tasks[0].projectDir, project);
    // …the legacy file renamed aside…
    const renamed = (await readdir(paths.dir)).filter((name) =>
      name.startsWith("tasks.json.imported."),
    );
    assert.equal(renamed.length, 1);
    assert.ok(!existsSync(paths.tasksFile));
    // …and artifacts untouched.
    assert.ok(existsSync(join(paths.runsDir, "run_1.json")));
  } finally {
    restore();
  }
});

test("importing is idempotent: a second call finds nothing to do", async () => {
  const restore = await withRegistryHome();
  try {
    const project = await mkdtemp(join(tmpdir(), "agents-cron-proj-"));
    const paths = schedulerPaths(project);
    await saveTasks(paths.tasksFile, []);

    await importLegacyStore(project);
    await importLegacyStore(project);

    assert.deepEqual(await loadRegistry(), []);
    const renamed = (await readdir(paths.dir)).filter((name) =>
      name.startsWith("tasks.json.imported."),
    );
    assert.equal(renamed.length, 1);
  } finally {
    restore();
  }
});

test("a task id already in the registry aborts the import loudly and keeps the legacy file", async () => {
  const restore = await withRegistryHome();
  try {
    const project = await mkdtemp(join(tmpdir(), "agents-cron-proj-"));
    const paths = schedulerPaths(project);
    await saveTasks(paths.tasksFile, [
      {
        id: "task_clash000",
        prompt: "clash",
        schedule: { kind: "interval", everyMs: 600_000 },
        enabled: true,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:00:00.000Z",
      },
    ]);
    await saveRegistry([{ ...registryTask("task_clash000"), projectDir: "/elsewhere" }]);

    await assert.rejects(importLegacyStore(project), /already in the registry/);
    // Neither imported nor renamed — the legacy file waits for the user.
    assert.ok(existsSync(paths.tasksFile));
    assert.equal((await loadRegistry()).length, 1);
  } finally {
    restore();
  }
});

test("updateRegistry serializes concurrent read-modify-writes", async () => {
  const restore = await withRegistryHome();
  try {
    await Promise.all([
      updateRegistry((tasks) => [...tasks, registryTask("task_aaaa1111")]),
      updateRegistry((tasks) => [...tasks, registryTask("task_bbbb2222")]),
    ]);

    const ids = (await loadRegistry()).map((task) => task.id);
    assert.deepEqual(ids.sort(), ["task_aaaa1111", "task_bbbb2222"]);
  } finally {
    restore();
  }
});

test("the registry saves and reloads version 2 tasks with their project binding", async () => {
  const restore = await withRegistryHome();
  try {
    const task = registryTask();
    await saveRegistry([task]);

    assert.deepEqual(await loadRegistry(), [task]);
    const raw = JSON.parse(await readFile(registryPaths().tasksFile, "utf8"));
    assert.equal(raw.version, 2);
    assert.equal(raw.tasks.length, 1);
  } finally {
    restore();
  }
});
