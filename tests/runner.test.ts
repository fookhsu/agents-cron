import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "../src/agents/registry.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "../src/agents/types.ts";
import { acquireLock } from "../src/lock.ts";
import { schedulerPaths } from "../src/paths.ts";
import { listRuns, writeRun } from "../src/runs.ts";
import { runDue, runTask } from "../src/runner.ts";
import { loadTasks, saveTasks } from "../src/storage.ts";
import type { ScheduleTask } from "../src/types.ts";

class FakeAgent implements AgentAdapter {
  readonly id = "fake";
  readonly displayName = "Fake";
  calls: Array<{ taskId: string; runId: string; projectDir: string }> = [];
  fail = false;

  async run({ task, run, projectDir }: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push({ taskId: task.id, runId: run.runId, projectDir });
    if (this.fail) throw new Error("provider unavailable");
    return { sessionFile: `/tmp/${run.runId}.jsonl`, summary: `Ran ${task.name ?? task.id}` };
  }
}

function registryFor(agent: AgentAdapter): AgentRegistry {
  return {
    resolve: async () => agent,
    list: () => [{ id: agent.id, displayName: agent.displayName }],
  };
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-cron-proj-"));
}

function task(overrides: Partial<ScheduleTask> & Pick<ScheduleTask, "id" | "schedule">): ScheduleTask {
  return {
    prompt: "Check CI",
    enabled: true,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
    ...overrides,
  };
}

test("runs a due recurring task and advances its next run from now", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({ id: "task_a", name: "check-ci", schedule: { kind: "interval", everyMs: 300_000 }, nextRunAt: "2026-09-01T10:05:00.000Z" }),
  ]);
  const agent = new FakeAgent();

  const result = await runDue({ projectDir, agents: registryFor(agent), now: new Date("2026-09-01T10:07:00.000Z") });

  assert.equal(result.skipped, false);
  assert.equal(result.failures, 0);
  assert.deepEqual(agent.calls.map((call) => call.runId), [result.runs[0].runId]);
  const [stored] = await loadTasks(paths.tasksFile);
  assert.equal(stored.nextRunAt, "2026-09-01T10:12:00.000Z");
  assert.equal(stored.enabled, true);
  const [run] = await listRuns(paths.runsDir);
  assert.equal(run.status, "success");
  assert.equal(run.agent, "fake");
  assert.equal(run.sessionFile, `/tmp/${run.runId}.jsonl`);
  assert.match(run.summary ?? "", /check-ci/);
});

test("runs a one-shot task within its grace window, then disables it", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({ id: "task_once", schedule: { kind: "once", runAt: "2026-09-01T10:01:00.000Z" }, nextRunAt: "2026-09-01T10:01:00.000Z" }),
  ]);
  const agent = new FakeAgent();

  const result = await runDue({ projectDir, agents: registryFor(agent), now: new Date("2026-09-01T10:02:00.000Z") });

  assert.equal(result.runs[0].status, "success");
  const [stored] = await loadTasks(paths.tasksFile);
  assert.equal(stored.enabled, false);
});

test("marks a one-shot task missed beyond its grace window", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({ id: "task_late", schedule: { kind: "once", runAt: "2026-09-01T09:00:00.000Z" }, nextRunAt: "2026-09-01T09:00:00.000Z" }),
  ]);
  const agent = new FakeAgent();

  const result = await runDue({ projectDir, agents: registryFor(agent), now: new Date("2026-09-01T10:00:00.000Z") });

  assert.equal(result.missed, 1);
  assert.equal(agent.calls.length, 0);
  const [stored] = await loadTasks(paths.tasksFile);
  assert.equal(stored.enabled, false);
  const [run] = await listRuns(paths.runsDir);
  assert.equal(run.status, "missed");
});

test("records a failure without retrying a one-shot task", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({ id: "task_fail", schedule: { kind: "once", runAt: "2026-09-01T10:01:00.000Z" }, nextRunAt: "2026-09-01T10:01:00.000Z" }),
  ]);
  const agent = new FakeAgent();
  agent.fail = true;
  const agents = registryFor(agent);

  const first = await runDue({ projectDir, agents, now: new Date("2026-09-01T10:01:30.000Z") });
  const second = await runDue({ projectDir, agents, now: new Date("2026-09-01T10:02:00.000Z") });

  assert.equal(first.failures, 1);
  assert.equal(second.runs.length, 0);
  assert.equal(agent.calls.length, 1);
  const [run] = await listRuns(paths.runsDir);
  assert.equal(run.status, "error");
  assert.match(run.error ?? "", /provider unavailable/);
});

test("advances a failed recurring task to its next cycle", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({ id: "task_loop", schedule: { kind: "interval", everyMs: 300_000 }, nextRunAt: "2026-09-01T10:05:00.000Z" }),
  ]);
  const agent = new FakeAgent();
  agent.fail = true;

  await runDue({ projectDir, agents: registryFor(agent), now: new Date("2026-09-01T10:07:00.000Z") });

  const [stored] = await loadTasks(paths.tasksFile);
  assert.equal(stored.nextRunAt, "2026-09-01T10:12:00.000Z");
  assert.equal(stored.enabled, true);
});

test("passes a task's agent override to the registry", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({
      id: "task_other",
      agent: "other",
      schedule: { kind: "interval", everyMs: 300_000 },
      nextRunAt: "2026-09-01T10:05:00.000Z",
    }),
  ]);
  const agent = new FakeAgent();
  const requested: Array<string | undefined> = [];
  const agents: AgentRegistry = {
    resolve: async (id) => {
      requested.push(id);
      return agent;
    },
    list: () => [],
  };

  await runDue({ projectDir, agents, agent: "project-default", now: new Date("2026-09-01T10:07:00.000Z") });

  assert.deepEqual(requested, ["other"]);
});

test("skips while another live invocation owns the lock", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({ id: "task_locked", schedule: { kind: "interval", everyMs: 300_000 }, nextRunAt: "2026-09-01T10:05:00.000Z" }),
  ]);
  const lock = await acquireLock(paths.lockFile);
  const agent = new FakeAgent();

  const result = await runDue({ projectDir, agents: registryFor(agent), now: new Date("2026-09-01T10:07:00.000Z") });

  assert.equal(result.skipped, true);
  assert.equal(agent.calls.length, 0);
  await lock?.release();
});

test("reclaims a stale running run and executes the task again", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({ id: "task_crash", schedule: { kind: "interval", everyMs: 300_000 }, nextRunAt: "2026-09-01T10:05:00.000Z" }),
  ]);
  await writeRun(paths.runsDir, {
    runId: "run_crashed",
    taskId: "task_crash",
    trigger: "scheduled",
    startedAt: "2026-09-01T09:00:00.000Z",
    status: "running",
  });
  const agent = new FakeAgent();

  await runDue({ projectDir, agents: registryFor(agent), now: new Date("2026-09-01T10:07:00.000Z") });

  const runs = await listRuns(paths.runsDir);
  const crashed = runs.find((run) => run.runId === "run_crashed");
  assert.equal(crashed?.status, "error");
  assert.equal(agent.calls.length, 1);
});

test("manual run executes a task without changing its schedule", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await saveTasks(paths.tasksFile, [
    task({ id: "task_manual", schedule: { kind: "interval", everyMs: 300_000 }, nextRunAt: "2026-09-03T10:05:00.000Z" }),
  ]);
  const agent = new FakeAgent();

  const outcome = await runTask(projectDir, "task_manual", {
    agents: registryFor(agent),
    now: new Date("2026-09-01T10:07:00.000Z"),
  });

  assert.equal(outcome.status, "success");
  const [stored] = await loadTasks(paths.tasksFile);
  assert.equal(stored.nextRunAt, "2026-09-03T10:05:00.000Z");
  const [run] = await listRuns(paths.runsDir);
  assert.equal(run.trigger, "manual");
});
