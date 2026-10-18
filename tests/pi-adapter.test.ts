import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_BIN_ENV, piArgs, resolvePiBinary } from "../src/agents/pi/adapter.ts";
import type { RunRecord, ScheduleTask } from "../src/types.ts";

const task: ScheduleTask = {
  id: "task_1",
  name: "check-ci",
  prompt: "check the CI",
  schedule: { kind: "interval", everyMs: 1_800_000 },
  enabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const run: RunRecord = {
  runId: "run_1",
  taskId: "task_1",
  trigger: "scheduled",
  startedAt: "2026-09-01T10:00:00.000Z",
  status: "running",
};

test("runs pi non-interactively against the task's session file", () => {
  const args = piArgs(task, run, "/tmp/sessions/task_1/run_1.jsonl");

  assert.deepEqual(args.slice(0, 3), ["--print", "--session", "/tmp/sessions/task_1/run_1.jsonl"]);
  assert.equal(args.at(-1), [
    "[Scheduled task]",
    "Task ID: task_1",
    "Task name: check-ci",
    "Run ID: run_1",
    "",
    "check the CI",
  ].join("\n"));
});

test("passes the task's overrides through to pi", () => {
  const args = piArgs(
    { ...task, model: "deepseek/deepseek-v4-flash", thinking: "low", tools: ["read", "bash"] },
    run,
    "/tmp/run.jsonl",
  );

  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "deepseek/deepseek-v4-flash");
  assert.equal(args[args.indexOf("--thinking") + 1], "low");
  assert.equal(args[args.indexOf("--tools") + 1], "read,bash");
});

test("omits overrides the task does not set, so pi keeps its own defaults", () => {
  const args = piArgs(task, run, "/tmp/run.jsonl");

  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--thinking"));
  assert.ok(!args.includes("--tools"));
});

test("an explicit binary override wins over PATH", () => {
  assert.equal(resolvePiBinary({ [PI_BIN_ENV]: "/opt/custom/pi", PATH: "" }), "/opt/custom/pi");
  assert.equal(
    resolvePiBinary({ PI_SCHEDULER_PI_BIN: "/opt/legacy/pi", PATH: "" }),
    "/opt/legacy/pi",
    "the pre-rename PI_SCHEDULER_* spelling is still honored",
  );
});

test("finds an executable named pi on PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-bin-"));
  try {
    const bin = join(dir, "pi");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);

    assert.equal(resolvePiBinary({ PATH: dir }), bin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explains how to fix a missing pi instead of failing at spawn time", () => {
  assert.throws(() => resolvePiBinary({ PATH: "" }), /Could not find "pi" on PATH/);
  assert.throws(() => resolvePiBinary({ PATH: "" }), new RegExp(PI_BIN_ENV));
});
