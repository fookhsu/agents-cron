import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTasks, saveTasks } from "../src/storage.ts";
import type { ScheduleTask } from "../src/types.ts";

function task(id = "task_test"): ScheduleTask {
  return {
    id,
    name: "test",
    prompt: "check status",
    schedule: { kind: "interval", everyMs: 300_000 },
    enabled: true,
    nextRunAt: "2026-09-01T10:05:00.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  };
}

test("missing task file loads as an empty list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-"));
  assert.deepEqual(await loadTasks(join(dir, "tasks.json")), []);
});

test("saves and reloads versioned tasks atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-"));
  const path = join(dir, ".agents", "cron", "tasks.json");
  await saveTasks(path, [task()]);
  assert.deepEqual(await loadTasks(path), [task()]);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.tasks.length, 1);
});

test("isolates malformed tasks while loading valid tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-"));
  const path = join(dir, "tasks.json");
  await saveTasks(path, [task()]);
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.tasks.push({ id: "bad", prompt: 42 });
  await writeFile(path, JSON.stringify(raw));
  assert.deepEqual(await loadTasks(path), [task()]);
});
