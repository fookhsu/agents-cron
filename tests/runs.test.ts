import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunId,
  createTaskId,
  listRuns,
  listRunsForTask,
  pruneRuns,
  readRun,
  reclaimStaleRuns,
  writeRun,
} from "../src/runs.ts";
import type { RunRecord } from "../src/types.ts";

async function runsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agents-cron-runs-"));
}

function run(overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "taskId">): RunRecord {
  return {
    trigger: "scheduled",
    startedAt: "2026-09-01T10:00:00.000Z",
    status: "success",
    ...overrides,
  };
}

test("generates prefixed ids readable from their timestamp", () => {
  assert.match(createTaskId(), /^task_[0-9a-f]{8}$/);
  assert.match(createRunId(new Date("2026-09-01T10:00:00.000Z")), /^run_20260901100000_[0-9a-f]{8}$/);
});

test("writes, reads, and lists run records newest first", async () => {
  const dir = await runsDir();
  await writeRun(dir, run({ runId: "run_a", taskId: "task_1", startedAt: "2026-09-01T10:00:00.000Z" }));
  await writeRun(dir, run({ runId: "run_b", taskId: "task_2", startedAt: "2026-09-01T11:00:00.000Z" }));

  assert.equal((await readRun(dir, "run_a"))?.runId, "run_a");
  assert.equal((await readRun(dir, "missing")), undefined);
  assert.deepEqual((await listRuns(dir)).map((entry) => entry.runId), ["run_b", "run_a"]);
  assert.deepEqual((await listRunsForTask(dir, "task_1")).map((entry) => entry.runId), ["run_a"]);
});

test("reclaims only runs stuck past the timeout", async () => {
  const dir = await runsDir();
  await writeRun(dir, run({ runId: "run_stale", taskId: "task_1", status: "running", startedAt: "2026-09-01T10:00:00.000Z" }));
  await writeRun(dir, run({ runId: "run_fresh", taskId: "task_1", status: "running", startedAt: "2026-09-01T10:29:00.000Z" }));

  const reclaimed = await reclaimStaleRuns(dir, new Date("2026-09-01T10:31:00.000Z"), 30);

  assert.deepEqual(reclaimed.map((entry) => entry.runId), ["run_stale"]);
  assert.equal((await readRun(dir, "run_stale"))?.status, "error");
  assert.equal((await readRun(dir, "run_fresh"))?.status, "running");
});

test("prunes each task independently", async () => {
  const dir = await runsDir();
  for (const [index, hour] of ["10", "11", "12"].entries()) {
    await writeRun(dir, run({ runId: `run_t1_${index}`, taskId: "task_1", startedAt: `2026-09-01T${hour}:00:00.000Z` }));
  }
  await writeRun(dir, run({ runId: "run_t2_0", taskId: "task_2", startedAt: "2026-09-01T10:00:00.000Z" }));

  assert.equal(await pruneRuns(dir, undefined, 2), 1);
  assert.deepEqual((await listRuns(dir)).map((entry) => entry.runId).sort(), ["run_t1_1", "run_t1_2", "run_t2_0"]);
});

test("prune removes the pruned runs' report files with them", async () => {
  const dir = await runsDir();
  const reports = join(dir, "..", "reports");
  for (const [index, hour] of ["10", "11", "12"].entries()) {
    const runId = `run_t1_${index}`;
    await writeRun(dir, run({ runId, taskId: "task_1", startedAt: `2026-09-01T${hour}:00:00.000Z` }));
    await mkdir(join(reports, "task_1"), { recursive: true });
    await writeFile(join(reports, "task_1", `${runId}.md`), "# Run report");
  }

  assert.equal(await pruneRuns(dir, reports, 2), 1);

  const left = (await readdir(join(reports, "task_1"))).sort();
  assert.deepEqual(left, ["run_t1_1.md", "run_t1_2.md"]);
});
