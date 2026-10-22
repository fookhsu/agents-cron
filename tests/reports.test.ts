import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRunReport } from "../src/reports.ts";
import type { RunRecord, ScheduleTask } from "../src/types.ts";

function task(): ScheduleTask {
  return {
    id: "task_12fc377e",
    projectDir: "/home/edy/demo/webapp",
    name: "nightly-audit",
    prompt: "每日安全审计并生成报告",
    schedule: { kind: "cron", expression: "0 0 0 * * *" },
    enabled: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: "run_20261022T062212Z_deadbeef",
    taskId: "task_12fc377e",
    trigger: "scheduled",
    startedAt: "2026-10-22T06:22:12.657Z",
    finishedAt: "2026-10-22T06:22:41.000Z",
    status: "success",
    exitCode: 0,
    agent: "pi",
    sessionFile: "/home/edy/demo/webapp/.agents/cron/sessions/task_12fc377e/run_20261022T062212Z_deadbeef.jsonl",
    summary: "审计完成，无新问题。\n共检查 12 项。",
    ...overrides,
  };
}

test("a success report carries metadata and the full summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-reports-"));

  await writeRunReport(dir, task(), run({}));

  const md = await readFile(join(dir, "task_12fc377e", "run_20261022T062212Z_deadbeef.md"), "utf8");
  assert.match(md, /# Run report: nightly-audit/);
  assert.match(md, /Task: `task_12fc377e`/);
  assert.match(md, /Status: success/);
  assert.match(md, /Trigger: scheduled/);
  assert.match(md, /Started: 2026-10-22T06:22:12\.657Z/);
  assert.match(md, /Finished: 2026-10-22T06:22:41\.000Z/);
  assert.match(md, /sessions\/task_12fc377e\/run_20261022T062212Z_deadbeef\.jsonl/);
  assert.match(md, /## Summary\n\n审计完成，无新问题。\n共检查 12 项。/);
});

test("an error report adds the error section; a missed report has neither summary nor session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-reports-"));

  await writeRunReport(
    dir,
    task(),
    run({ status: "error", exitCode: 1, summary: undefined, sessionFile: undefined, error: "provider unavailable" }),
  );
  await writeRunReport(
    dir,
    task(),
    run({
      runId: "run_20261022T070000Z_cafebabe",
      status: "missed",
      startedAt: "2026-10-22T07:00:00.000Z",
      finishedAt: "2026-10-22T07:00:00.000Z",
      exitCode: 1,
      summary: undefined,
      sessionFile: undefined,
      error: "Planned time passed before any run claimed this task",
    }),
  );

  const errorMd = await readFile(join(dir, "task_12fc377e", "run_20261022T062212Z_deadbeef.md"), "utf8");
  assert.match(errorMd, /Status: error/);
  assert.match(errorMd, /## Error\n\nprovider unavailable/);
  assert.ok(!errorMd.includes("## Summary"));

  const missedMd = await readFile(join(dir, "task_12fc377e", "run_20261022T070000Z_cafebabe.md"), "utf8");
  assert.match(missedMd, /Status: missed/);
  assert.match(missedMd, /## Error\n\nPlanned time passed/);
  assert.ok(!missedMd.includes("## Summary"));
  assert.ok(!missedMd.includes("sessions/"));
});
