import test, { before, beforeEach, after } from "node:test";

// Every test runs against a throwaway Task Registry.
let restoreHome: (() => void) | undefined;
before(async () => {
  const home = await mkdtemp(join(tmpdir(), "agents-cron-home-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  restoreHome = () => {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
  };
});
after(() => restoreHome?.());

beforeEach(async () => {
  const { saveRegistry } = await import("../src/registry.ts");
  await saveRegistry([]);
});
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
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-dash-"));
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
    // Aggregates ride along so a caller need not walk the array to count.
    assert.equal(overview.total, 1);
    assert.equal(overview.enabled, 1);
    assert.equal(overview.failures, 0);
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
    assert.match(html, /<title>agents-cron dashboard<\/title>/);
    assert.match(html, /id="task-prompt"/);
    assert.match(html, /show prompt/);
    assert.match(html, /agents-cron-dash-/);
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

    // Truncation is stated, not implied: a caller can tell a short list from a
    // cut one without guessing from the array length.
    const limited = await (await fetch(`${url}&limit=1`)).json();
    assert.equal(limited.runs.length, 1);
    assert.equal(limited.returned, 1);
    assert.equal(limited.total, 2);
    assert.equal(limited.has_more, true);
    assert.equal(limited.next_limit, 2);

    const complete = await (await fetch(`${url}&limit=10`)).json();
    assert.equal(complete.has_more, false);
    assert.equal(complete.returned, 2);
    assert.equal(complete.total, 2);
    assert.equal("next_limit" in complete, false);

    const missing = await fetch(`${handle.url}api/runs?taskId=task_none`);
    const missingBody = await missing.json();
    assert.equal(missing.status, 200);
    assert.equal(missingBody.runs.length, 0);
    assert.equal(missingBody.total, 0);
    assert.equal(missingBody.has_more, false); // an empty history is not a truncated one

    const unfiltered = await fetch(`${handle.url}api/runs`);
    assert.equal(unfiltered.status, 400);
    // A machine reads the code, not the prose.
    assert.deepEqual((await unfiltered.json()).error.code, "missing_parameter");
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

test("a run whose record points outside the private layout serves from that path", async () => {
  const project = await seedProject();
  const storeDir = join(project.dir, "pi-store", "--encoded-cwd--");
  await mkdir(storeDir, { recursive: true });
  const storeRun: RunRecord = {
    runId: "run_20261016T110000Z_storefed",
    taskId: project.task.id,
    trigger: "scheduled",
    startedAt: "2026-10-16T11:00:00.000Z",
    status: "success",
    finishedAt: "2026-10-16T11:01:00.000Z",
    exitCode: 0,
    sessionFile: join(storeDir, `${project.task.id}-run_20261016T110000Z_storefed.jsonl`),
  };
  await writeFile(storeRun.sessionFile!, '{"type":"session"}\n');
  await writeRun(schedulerPaths(project.dir).runsDir, storeRun);
  const handle = await startDashboard({ projectDir: project.dir, port: 0 });
  try {
    const response = await fetch(`${handle.url}api/session/${storeRun.taskId}/${storeRun.runId}`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(await response.text(), /session/);
  } finally {
    await handle.close();
    await rm(project.dir, { recursive: true, force: true });
  }
});

test("writes are rejected and unknown routes are 404s", async () => {
  const project = await seedProject();
  const handle = await startDashboard({ projectDir: project.dir, port: 0 });
  try {
    const post = await fetch(`${handle.url}api/overview`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal((await post.json()).error.code, "method_not_allowed");

    const unknown = await fetch(`${handle.url}api/nope`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "not_found");
  } finally {
    await handle.close();
    await rm(project.dir, { recursive: true, force: true });
  }
});

test("the dashboard serves every project's tasks with their own runs", async () => {
  const alpha = await seedProject();
  const beta = await seedProject();
  const elsewhere = await mkdtemp(join(tmpdir(), "agents-cron-dash-"));
  const handle = await startDashboard({ projectDir: elsewhere, port: 0 });
  try {
    const overview = await (await fetch(`${handle.url}api/overview`)).json();
    assert.equal(overview.tasks.length, 2);

    const history = await (await fetch(`${handle.url}api/runs?taskId=${beta.task.id}`)).json();
    assert.equal(history.runs.length, 2);
    assert.ok(history.runs.every((run: RunRecord) => run.taskId === beta.task.id));
  } finally {
    await handle.close();
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("a corrupt registry answers with its code, not an empty task list", async () => {
  // An empty task list would read as "nothing is scheduled"; the fault has to
  // be visible to a machine without it parsing prose.
  const home = await mkdtemp(join(tmpdir(), "agents-cron-dash-corrupt-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const { mkdir: makeDir } = await import("node:fs/promises");
  try {
    const registryDir = join(home, ".agents", "cron");
    await makeDir(registryDir, { recursive: true });
    await writeFile(join(registryDir, "tasks.json"), "{not json", "utf8");
    const dir = await mkdtemp(join(tmpdir(), "agents-cron-dash-corrupt-proj-"));
    const handle = await startDashboard({ projectDir: dir, port: 0 });
    try {
      const response = await fetch(`${handle.url}api/overview`);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error.code, "corrupt_registry");
      assert.match(body.error.message, /tasks\.json/);
    } finally {
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
  }
});
