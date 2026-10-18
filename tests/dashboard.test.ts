import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboard } from "../src/dashboard/server.ts";
import { schedulerPaths } from "../src/paths.ts";
import { writeRun } from "../src/runs.ts";
import { addTask } from "../src/task-service.ts";
import type { RunRecord, ScheduleTask } from "../src/types.ts";

async function seedProject(): Promise<{ dir: string; task: ScheduleTask; runs: RunRecord[] }> {
  const dir = await mkdtemp(join(tmpdir(), "agent-cron-dash-"));
  const task = await addTask(dir, {
    prompt: "check the CI",
    schedule: { kind: "interval", every: "30m" },
    name: "ci-check",
    agent: "claude",
  });
  const paths = schedulerPaths(dir);
  const base: RunRecord = {
    runId: "run_20261016T100000Z_deadbeef",
    taskId: task.id,
    trigger: "scheduled",
    startedAt: "2026-10-16T10:00:00.000Z",
    status: "running",
  };
  const failed: RunRecord = {
    ...base,
    runId: "run_20261016T100500Z_deadbeef",
    startedAt: "2026-10-16T10:05:00.000Z",
    finishedAt: "2026-10-16T10:05:20.000Z",
    status: "error",
    exitCode: 1,
    error: "claude reported an error",
  };
  const ok: RunRecord = {
    ...base,
    runId: "run_20261016T103000Z_deadbeef",
    startedAt: "2026-10-16T10:30:00.000Z",
    finishedAt: "2026-10-16T10:31:00.000Z",
    status: "success",
    exitCode: 0,
    summary: "CI is green",
  };
  await writeRun(paths.runsDir, failed);
  await writeRun(paths.runsDir, ok);
  await mkdir(join(paths.sessionsDir, task.id), { recursive: true });
  await writeFile(
    join(paths.sessionsDir, task.id, `${ok.runId}.json`),
    JSON.stringify({ type: "result", result: "CI is green" }),
  );
  return { dir, task, runs: [ok, failed] };
}

test("the dashboard serves tasks with their latest run, newest first", async () => {
  const project = await seedProject();
  const handle = await startDashboard({ projectDir: project.dir, port: 0 });
  try {
    const overview = await (await fetch(`${handle.url}api/overview`)).json();

    assert.equal(overview.tasks.length, 1);
    const [task] = overview.tasks;
    assert.equal(task.id, project.task.id);
    assert.equal(task.latestRun.runId, project.runs[0].runId);
    assert.equal(task.latestRun.status, "success");
    assert.ok(overview.generatedAt);
  } finally {
    await handle.close();
    await rm(project.dir, { recursive: true, force: true });
  }
});

test("the dashboard page is self-contained HTML", async () => {
  const project = await seedProject();
  const handle = await startDashboard({ projectDir: project.dir, port: 0 });
  try {
    const response = await fetch(handle.url);
    const html = await response.text();

    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /<title>agent-cron dashboard<\/title>/);
    assert.match(html, /agent-cron-dash-/);
  } finally {
    await handle.close();
    await rm(project.dir, { recursive: true, force: true });
  }
});

test("run history filters by task and honors the limit", async () => {
  const project = await seedProject();
  const handle = await startDashboard({ projectDir: project.dir, port: 0 });
  try {
    const url = `${handle.url}api/runs?taskId=${encodeURIComponent(project.task.id)}`;
    const all = await (await fetch(url)).json();
    assert.deepEqual(all.runs.map((run: RunRecord) => run.runId), [
      project.runs[0].runId,
      project.runs[1].runId,
    ]);

    const limited = await (await fetch(`${url}&limit=1`)).json();
    assert.equal(limited.runs.length, 1);

    const missing = await fetch(`${handle.url}api/runs?taskId=task_none`);
    assert.equal((await missing.json()).runs.length, 0);

    const unfiltered = await fetch(`${handle.url}api/runs`);
    assert.equal(unfiltered.status, 400);
  } finally {
    await handle.close();
    await rm(project.dir, { recursive: true, force: true });
  }
});

test("session records serve as json or jsonl, and probes get 404s", async () => {
  const project = await seedProject();
  const handle = await startDashboard({ projectDir: project.dir, port: 0 });
  try {
    const okRun = project.runs[0];
    const record = await fetch(`${handle.url}api/session/${okRun.taskId}/${okRun.runId}`);
    assert.equal(record.status, 200);
    assert.match(record.headers.get("content-type") ?? "", /application\/json/);
    assert.match(await record.text(), /CI is green/);

    const missing = await fetch(`${handle.url}api/session/${okRun.taskId}/run_nope`);
    assert.equal(missing.status, 404);

    const probe = await fetch(`${handle.url}api/session/..%2F..%2Ftasks/${okRun.runId}`);
    assert.equal(probe.status, 404);

    const traversal = await fetch(`${handle.url}api/tasks.json`);
    assert.equal(traversal.status, 404);
  } finally {
    await handle.close();
    await rm(project.dir, { recursive: true, force: true });
  }
});

test("writes are rejected and unknown routes are 404s", async () => {
  const project = await seedProject();
  const handle = await startDashboard({ projectDir: project.dir, port: 0 });
  try {
    assert.equal((await fetch(`${handle.url}api/overview`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${handle.url}api/nope`)).status, 404);
  } finally {
    await handle.close();
    await rm(project.dir, { recursive: true, force: true });
  }
});
