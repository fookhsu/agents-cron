import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_BIN_ENV,
  CodexRunError,
  codexArgs,
  codexSessionFile,
  parseCodexResult,
  resolveCodexBinary,
} from "../src/agents/codex/adapter.ts";
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

test("runs codex non-interactively in read-only sandbox when the task names no tools", () => {
  const args = codexArgs(task, run, "/tmp/last.txt");

  assert.equal(args[0], "exec");
  assert.deepEqual(args.slice(1, 6), ["--json", "--skip-git-repo-check", "--output-last-message", "/tmp/last.txt", "--sandbox"]);
  assert.equal(args[6], "read-only");
  assert.equal(args.at(-1), [
    "[Scheduled task]",
    "Task ID: task_1",
    "Task name: check-ci",
    "Run ID: run_1",
    "",
    "check the CI",
  ].join("\n"));
});

test("a task with tools widens the sandbox to workspace-write", () => {
  const args = codexArgs({ ...task, tools: ["shell", "apply_patch"] }, run, "/tmp/last.txt");

  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
});

test("passes the task's model through, and ignores thinking", () => {
  const args = codexArgs({ ...task, model: "gpt-5.1-codex", thinking: "high" }, run, "/tmp/last.txt");

  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.1-codex");
  assert.ok(!args.some((arg) => arg.toLowerCase().includes("think")));
});

test("the session record sits next to the pi sessions, as JSON", () => {
  const file = codexSessionFile("/proj", "task_1", "run_1");

  assert.equal(file, join("/proj", ".pi", "scheduler", "sessions", "task_1", "run_1.json"));
});

test("an explicit binary override wins over PATH", () => {
  assert.equal(resolveCodexBinary({ [CODEX_BIN_ENV]: "/opt/custom/codex", PATH: "" }), "/opt/custom/codex");
  assert.equal(
    resolveCodexBinary({ PI_SCHEDULER_CODEX_BIN: "/opt/legacy/codex", PATH: "" }),
    "/opt/legacy/codex",
    "the pre-rename PI_SCHEDULER_* spelling is still honored",
  );
});

test("finds an executable named codex on PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-cron-bin-"));
  try {
    const bin = join(dir, "codex");
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);

    assert.equal(resolveCodexBinary({ PATH: dir }), bin);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explains how to fix a missing codex instead of failing at spawn time", () => {
  assert.throws(() => resolveCodexBinary({ PATH: "" }), /Could not find "codex" on PATH/);
  assert.throws(() => resolveCodexBinary({ PATH: "" }), new RegExp(CODEX_BIN_ENV));
});

test("parses a successful run from the captured final message", () => {
  const events = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "CI is green" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10 } }),
  ].join("\n");
  const result = parseCodexResult(events, 0, "", "CI is green");

  assert.equal(result.text, "CI is green");
  assert.equal(result.raw.exitCode, 0);
  assert.deepEqual(result.raw.events, JSON.parse(`[${events.replace(/\n/g, ",")}]`));
});

test("falls back to the last agent message in the event stream", () => {
  const events = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "stale message" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final message" } }),
  ].join("\n");
  const result = parseCodexResult(events, 0, "", "");

  assert.equal(result.text, "final message");
});

test("a non-zero exit fails the run but keeps the payload", () => {
  assert.throws(
    () => parseCodexResult("", 1, "stream error", "partial answer"),
    (error: unknown) => {
      assert.ok(error instanceof CodexRunError);
      assert.match(error.message, /codex exited with 1: stream error/);
      assert.equal(error.result.lastMessage, "partial answer");
      return true;
    },
  );
});

test("a run without any final message is reported with its exit code", () => {
  assert.throws(() => parseCodexResult("noise", 2, "boom", ""), (error: unknown) => {
    assert.ok(error instanceof CodexRunError);
    assert.match(error.message, /codex exited with 2 without a final message: boom/);
    return true;
  });
  assert.throws(() => parseCodexResult("", 0, "", ""), (error: unknown) => {
    assert.ok(error instanceof CodexRunError);
    assert.match(error.message, /exited with 0 without a final message/);
    return true;
  });
});
