import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { schedulerPaths, sessionFileFor } from "../src/paths.ts";

/** Builds a pre-0.7 legacy store with one task, one run record, one session. */
function legacyStore(project: string): void {
  const legacy = join(project, ".pi", "scheduler");
  mkdirSync(join(legacy, "runs"), { recursive: true });
  mkdirSync(join(legacy, "sessions", "task_1"), { recursive: true });
  writeFileSync(
    join(legacy, "tasks.json"),
    JSON.stringify({ version: 1, tasks: [{ id: "task_1", prompt: "p" }] }),
  );
  writeFileSync(join(legacy, "runs", "run_1.json"), "{}");
  writeFileSync(join(legacy, "sessions", "task_1", "run_1.jsonl"), "{}\n");
  writeFileSync(join(legacy, "run.lock"), "stale");
}

test("paths resolve under .agents/cron", () => {
  const paths = schedulerPaths("/proj");
  assert.equal(paths.dir, join("/proj", ".agents", "cron"));
  assert.equal(paths.tasksFile, join("/proj", ".agents", "cron", "tasks.json"));
  assert.equal(
    sessionFileFor(paths, "task_1", "run_1"),
    join("/proj", ".agents", "cron", "sessions", "task_1", "run_1.jsonl"),
  );
});

test("a legacy .pi/scheduler store is copied over on first access", () => {
  const project = mkdtempSync(join(tmpdir(), "agents-cron-paths-"));
  legacyStore(project);

  const paths = schedulerPaths(project);

  // Tasks, run records, and sessions carried over…
  const tasks = JSON.parse(readFileSync(paths.tasksFile, "utf8"));
  assert.equal(tasks.tasks[0].id, "task_1");
  assert.ok(existsSync(join(paths.runsDir, "run_1.json")));
  assert.ok(existsSync(sessionFileFor(paths, "task_1", "run_1")));
  // …the transient lock is not, and the old copy is left in place.
  assert.ok(!existsSync(join(paths.dir, "run.lock")));
  assert.ok(existsSync(join(project, ".pi", "scheduler", "tasks.json")));
});

test("an existing .agents/cron store is never overwritten by a legacy one", () => {
  const project = mkdtempSync(join(tmpdir(), "agents-cron-paths-"));
  legacyStore(project);
  const store = join(project, ".agents", "cron");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "tasks.json"), JSON.stringify({ version: 1, tasks: [] }));

  const paths = schedulerPaths(project);

  const tasks = JSON.parse(readFileSync(paths.tasksFile, "utf8"));
  assert.deepEqual(tasks.tasks, []);
});

test("a project without a legacy store stays untouched", () => {
  const project = mkdtempSync(join(tmpdir(), "agents-cron-paths-"));
  const paths = schedulerPaths(project);
  assert.ok(!existsSync(paths.dir));
  assert.ok(!existsSync(join(project, ".pi")));
});
