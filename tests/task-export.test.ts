import test from "node:test";
import assert from "node:assert/strict";
import { buildExportFile, EXPORT_VERSION, parseExportFile, toExportedTask } from "../src/task-export.ts";
import type { ScheduleTask } from "../src/types.ts";

/** A stored task as the registry keeps it, registry state and all. */
function storedTask(overrides: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: "task_abcdef01",
    projectDir: "/tmp/demo",
    prompt: "check CI",
    schedule: { kind: "cron", expression: "0 */5 * * * *" },
    enabled: true,
    nextRunAt: "2026-10-28T09:05:00.000Z",
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
    successCount: 3,
    errorCount: 1,
    ...overrides,
  };
}

test("a known-good export file parses back into definitions", () => {
  const raw = JSON.stringify({
    version: 1,
    exportedAt: "2026-10-28T00:00:00.000Z",
    tasks: [
      {
        name: "check CI",
        prompt: "check CI",
        schedule: { kind: "cron", expression: "0 */5 * * * *" },
        notify: "error",
        notifyTo: ["feishu"],
      },
    ],
  });

  const file = parseExportFile(raw);

  assert.equal(file.version, EXPORT_VERSION);
  assert.equal(file.exportedAt, "2026-10-28T00:00:00.000Z");
  assert.equal(file.tasks.length, 1);
  assert.equal(file.tasks[0].name, "check CI");
  assert.deepEqual(file.tasks[0].notifyTo, ["feishu"]);
});

test("a wrong version or a non-array tasks field is rejected", () => {
  assert.throws(() => parseExportFile('{"version": 2, "exportedAt": "x", "tasks": []}'), /Unsupported task export version: 2/);
  assert.throws(() => parseExportFile('{"version": 1, "exportedAt": "x", "tasks": {}}'), /tasks must be an array/);
  assert.throws(() => parseExportFile('not json'), /not valid JSON/);
});

test("a missing exportedAt is rejected", () => {
  assert.throws(() => parseExportFile('{"version": 1, "tasks": []}'), /exportedAt/);
});

test("malformed entries are rejected naming their index", () => {
  const raw = JSON.stringify({
    version: 1,
    exportedAt: "2026-10-28T00:00:00.000Z",
    tasks: [{ prompt: "ok", schedule: { kind: "cron", expression: "@daily" } }, { prompt: "", schedule: { kind: "cron", expression: "@daily" } }],
  });

  assert.throws(() => parseExportFile(raw), /task 2: prompt must be a non-empty string/);
});

test("schedules are validated as deeply as addTask validates them", () => {
  const file = (schedule: unknown) =>
    JSON.stringify({ version: 1, exportedAt: "2026-10-28T00:00:00.000Z", tasks: [{ prompt: "p", schedule }] });

  assert.throws(() => parseExportFile(file({ kind: "cron", expression: "not cron" })), /cron/i);
  assert.throws(() => parseExportFile(file({ kind: "interval", everyMs: 30_000 })), /at least 1 minute/i);
  assert.throws(() => parseExportFile(file({ kind: "once", runAt: "tomorrow" })), /runAt/i);
  assert.throws(() => parseExportFile(file({ kind: "hourly" })), /schedule.kind/);
});

test("a five-field cron expression is canonicalised on parse, like the store keeps it", () => {
  const file = parseExportFile(
    JSON.stringify({
      version: 1,
      exportedAt: "2026-10-28T00:00:00.000Z",
      tasks: [{ prompt: "p", schedule: { kind: "cron", expression: "*/5 * * * *" } }],
    }),
  );

  assert.deepEqual(file.tasks[0].schedule, { kind: "cron", expression: "0 */5 * * * *" });
});

test("toExportedTask keeps the definition and drops identity and registry state", () => {
  const exported = toExportedTask(
    storedTask({
      name: "ci-watch",
      enabled: false,
      lastRunAt: "2026-10-27T09:00:00.000Z",
      lastStatus: "error",
      missedCount: 2,
      notify: "error",
      notifyTo: ["feishu"],
      agent: "pi",
      model: "river",
      thinking: "low",
      cwd: "packages/web",
      tools: ["bash", "read"],
    }),
  );

  assert.deepEqual(exported, {
    name: "ci-watch",
    prompt: "check CI",
    schedule: { kind: "cron", expression: "0 */5 * * * *" },
    agent: "pi",
    model: "river",
    thinking: "low",
    cwd: "packages/web",
    tools: ["bash", "read"],
    notify: "error",
    notifyTo: ["feishu"],
  });

  // A bare task exports only what it defines — no empty-string or empty-list filler.
  const bare = toExportedTask(storedTask());
  assert.deepEqual(Object.keys(bare), ["prompt", "schedule"]);
});

test("buildExportFile stamps the version and export time", () => {
  const file = buildExportFile([storedTask()], new Date("2026-10-28T01:02:03.000Z"));

  assert.equal(file.version, 1);
  assert.equal(file.exportedAt, "2026-10-28T01:02:03.000Z");
  assert.equal(file.tasks.length, 1);
  assert.equal("id" in file.tasks[0], false);
});
