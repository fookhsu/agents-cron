import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_BIN_ENV,
  claudeArgs,
  claudeSessionFile,
  ClaudeRunError,
  parseClaudeResult,
  resolveClaudeBinary,
} from "../src/agents/claude/adapter.ts";
import type { RunRecord, ScheduleTask } from "../src/types.ts";

const task: ScheduleTask = {
  id: "task_1",
  projectDir: "/proj",
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

test("runs claude non-interactively and asks for JSON output", () => {
  const args = claudeArgs(task, run);

  assert.deepEqual(args.slice(0, 3), ["--print", "--output-format", "json"]);
  assert.equal(args.at(-1), [
    "[Scheduled task]",
    "Task ID: task_1",
    "Task name: check-ci",
    "Run ID: run_1",
    "",
    "check the CI",
  ].join("\n"));
});

test("passes the task's model and tools through to claude", () => {
  const args = claudeArgs({ ...task, model: "claude-sonnet-4-5", tools: ["Read", "Bash", "Grep"] }, run);

  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-4-5");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Bash,Grep");
});

test("omits overrides the task does not set, and ignores thinking", () => {
  const args = claudeArgs({ ...task, thinking: "high" }, run);

  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--allowedTools"));
  assert.ok(!args.some((arg) => arg.toLowerCase().includes("think")));
});

test("the session record sits next to the pi sessions, as JSON", () => {
  const file = claudeSessionFile("/proj", "task_1", "run_1");

  assert.equal(file, join("/proj", ".agents", "cron", "sessions", "task_1", "run_1.json"));
});

test("an explicit binary override wins over PATH", () => {
  assert.equal(resolveClaudeBinary({ [CLAUDE_BIN_ENV]: "/opt/custom/claude", PATH: "" }), "/opt/custom/claude");
  assert.equal(
    resolveClaudeBinary({ PI_SCHEDULER_CLAUDE_BIN: "/opt/legacy/claude", PATH: "" }),
    "/opt/legacy/claude",
    "the pre-rename PI_SCHEDULER_* spelling is still honored",
  );
});

test("finds an executable named claude on PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-bin-"));
  try {
    const bin = join(dir, "claude");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);

    assert.equal(resolveClaudeBinary({ PATH: dir }), bin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explains how to fix a missing claude instead of failing at spawn time", () => {
  assert.throws(() => resolveClaudeBinary({ PATH: "" }), /Could not find "claude" on PATH/);
  assert.throws(() => resolveClaudeBinary({ PATH: "" }), new RegExp(CLAUDE_BIN_ENV));
});

test("parses a successful result message", () => {
  const result = parseClaudeResult(
    JSON.stringify({ type: "result", session_id: "abc", result: "CI is green" }),
    0,
    "",
  );

  assert.equal(result.text, "CI is green");
  assert.equal(result.raw.session_id, "abc");
});

test("a result Claude flagged as an error fails the run but keeps the payload", () => {
  const payload = JSON.stringify({ type: "result", is_error: true, result: "No permission for Bash" });

  assert.throws(() => parseClaudeResult(payload, 0, ""), (error: unknown) => {
    assert.ok(error instanceof ClaudeRunError);
    assert.match(error.message, /No permission for Bash/);
    assert.equal(error.result.is_error, true);
    return true;
  });
});

test("a non-JSON or failed process is reported with its stderr tail", () => {
  assert.throws(() => parseClaudeResult("", 1, "line1\nboom"), /claude exited with 1: line1 \/ boom/);
  assert.throws(() => parseClaudeResult("not json", 2, ""), /claude exited with 2/);
});
