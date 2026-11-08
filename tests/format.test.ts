import test from "node:test";
import assert from "node:assert/strict";
import {
  firstLine,
  formatInterval,
  formatRunLine,
  formatSchedule,
  formatTaskDetail,
  formatTaskLine,
  previewPrompt,
  stamp,
} from "../src/format.ts";
import type { RunRecord, ScheduleTask } from "../src/types.ts";

/**
 * The shared vocabulary. These tests exist because the CLI, the `schedule_task`
 * tool, the slash commands, and the dashboard all print the same records: the
 * assertions here are the ones each surface's own test used to make separately,
 * and the reason a second implementation cannot quietly reappear.
 */

function task(overrides: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: "task_ab12",
    projectDir: "/project",
    prompt: "Check CI",
    schedule: { kind: "interval", everyMs: 1_800_000 },
    enabled: true,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run_20260901T100000Z_ab12",
    taskId: "task_ab12",
    trigger: "scheduled",
    startedAt: "2026-09-01T10:00:00.000Z",
    finishedAt: "2026-09-01T10:00:30.000Z",
    status: "success",
    ...overrides,
  };
}

test("an interval reads in its largest whole unit, never as raw milliseconds", () => {
  assert.equal(formatInterval(30_000), "30s");
  assert.equal(formatInterval(1_800_000), "30m");
  assert.equal(formatInterval(5_400_000), "90m");
  assert.equal(formatInterval(7_200_000), "2h");
  assert.equal(formatInterval(86_400_000), "1d");
  assert.equal(formatInterval(86_400_000 * 3), "3d");
  // A unit that does not divide evenly keeps the smaller one: 36h is not 1.5d.
  assert.equal(formatInterval(129_600_000), "36h");
  // Sub-second oddities keep their milliseconds rather than rounding away.
  assert.equal(formatInterval(1_500), "1500ms");
});

test("a schedule is one clause with the unit in the schedule", () => {
  assert.equal(formatSchedule(task()), "every 30m");
  assert.equal(formatSchedule(task({ schedule: { kind: "cron", expression: "0 9 * * 1-5" } })), "cron 0 9 * * 1-5");
  assert.equal(
    formatSchedule(task({ schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" } })),
    "cron 0 9 * * * (Asia/Shanghai)",
  );
  assert.equal(formatSchedule(task({ schedule: { kind: "once", runAt: "2026-09-01T10:00:00.000Z" } })), "once 2026-09-01T10:00:00Z");
});

test("stamps are compact ISO, and unset reads as never", () => {
  assert.equal(stamp("2026-09-01T10:00:00.000Z"), "2026-09-01T10:00:00Z");
  // A fractional second that is not .000 is real precision, so it stays.
  assert.equal(stamp("2026-09-01T10:00:00.250Z"), "2026-09-01T10:00:00.250Z");
  assert.equal(stamp(undefined), "never");
});

test("a task line carries state, schedule, next run, and latest outcome", () => {
  assert.equal(
    formatTaskLine(task({ nextRunAt: "2026-09-01T10:05:00.000Z" })),
    "task_ab12 [enabled] - — every 30m — next 2026-09-01T10:05:00Z — never run",
  );

  // The run record, when the caller read one, is the newest truth.
  assert.match(
    formatTaskLine(task({ nextRunAt: "2026-09-01T10:05:00.000Z" }), { latestRun: run({ status: "error" }) }),
    /last error at 2026-09-01T10:00:30Z$/,
  );

  // Without a run read, the registry's own state answers instead of "never run"
  // — a surface that cannot afford the read must not lie about history.
  assert.match(
    formatTaskLine(task({ lastRunAt: "2026-09-01T09:00:00.000Z", lastStatus: "error" })),
    /last error at 2026-09-01T09:00:00Z$/,
  );
  // A status with no timestamp is not a claim about when: it stays "never run".
  assert.match(formatTaskLine(task({ lastStatus: "missed" }), {}), /— never run$/);
  assert.match(formatTaskLine(task({ lastRunAt: "2026-09-01T09:00:00.000Z" })), /last run at 2026-09-01T09:00:00Z$/);
});

test("a task line can carry a suffix where the caller learned something extra", () => {
  const line = formatTaskLine(task({ nextRunAt: "2026-09-01T10:05:00.000Z" }), { suffix: " ⚠ missing directory" });
  assert.match(line, /— every 30m ⚠ missing directory — next 2026-09-01T10:05:00Z — never run$/);
});

test("the detailed view is the same facts, then the prompt verbatim", () => {
  const detail = formatTaskDetail(
    task({
      name: "ci",
      nextRunAt: "2026-09-01T10:05:00.000Z",
      lastRunAt: "2026-09-01T09:00:00.000Z",
      lastStatus: "success",
      successCount: 3,
      model: "anthropic/claude-opus-4-5",
      notifyTo: ["feishu"],
    }),
  );
  const lines = detail.split("\n");
  assert.equal(lines[0], "task_ab12 [enabled] ci");
  assert.equal(lines[1], "project: /project");
  assert.equal(lines[2], "schedule: every 30m");
  assert.equal(lines[3], "next run: 2026-09-01T10:05:00Z");
  assert.equal(lines[4], "last run: 2026-09-01T09:00:00Z (success)");
  assert.equal(lines[5], "runs: 3 success");
  assert.ok(lines.includes("model: anthropic/claude-opus-4-5"));
  assert.ok(lines.includes("notify to: feishu"));
  assert.match(detail, /prompt:\nCheck CI$/);
});

test("a run line leads with why it failed, unless the caller opts out", () => {
  const failed = run({ status: "error", error: "provider unavailable\nstack trace" });
  assert.equal(
    formatRunLine(failed),
    "run_20260901T100000Z_ab12 [error] scheduled — 2026-09-01T10:00:30Z — provider unavailable",
  );
  assert.doesNotMatch(formatRunLine(failed, { error: false }), /provider unavailable/);
  assert.match(formatRunLine(run({ sessionFile: "/s.jsonl" }), { session: true }), /— \/s\.jsonl$/);
  assert.match(formatRunLine(run({ summary: "all green", sessionFile: "/s.jsonl" }), { full: true }), /\n {2}session: \/s\.jsonl$/);
});

test("previews and first lines are bounded, and say when they cut", () => {
  assert.equal(previewPrompt("short"), "short");
  assert.equal(previewPrompt("x".repeat(50)), `${"x".repeat(40)}…`);
  assert.equal(firstLine(" one line \nsecond"), "one line");
  assert.equal(firstLine("y".repeat(200)).length, 121);
});
