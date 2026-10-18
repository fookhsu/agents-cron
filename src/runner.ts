import { acquireLock } from "./lock.ts";
import { agents as builtInAgents, type AgentRegistry } from "./agents/registry.ts";
import { dispatchNotifications } from "./notify/dispatch.ts";
import { loadNotifyConfig } from "./notify/config.ts";
import { schedulerPaths, type SchedulerPaths } from "./paths.ts";
import { createRunId, pruneRuns, reclaimStaleRuns, writeRun } from "./runs.ts";
import { calculateNextRun, isDue } from "./scheduling.ts";
import { loadTasks, saveTasks } from "./storage.ts";
import type { RunRecord, ScheduleTask, Trigger } from "./types.ts";

const DEFAULT_RUN_TIMEOUT_MINUTES = 30;
const DEFAULT_MISSED_GRACE_MINUTES = 5;
const DEFAULT_KEEP_RUNS = 20;

export type RunnerOptions = {
  projectDir: string;
  /** Agent adapter registry; defaults to the built-in agents. */
  agents?: AgentRegistry;
  /** Agent for tasks that name none; defaults to the registry's default. */
  agent?: string;
  now?: Date;
  runTimeoutMinutes?: number;
  missedGraceMinutes?: number;
  paths?: SchedulerPaths;
};

export type RunOutcome = {
  taskId: string;
  runId: string;
  status: RunRecord["status"];
};

export type RunDueResult = {
  /** Another live invocation owned the lock, so nothing was attempted. */
  skipped: boolean;
  runs: RunOutcome[];
  failures: number;
  missed: number;
};

export class TaskNotFoundError extends Error {}

/**
 * The Task Runner: one idempotent pass over the project's tasks. Callers invoke
 * it from cron (`run-due`) or directly for a single task (`run <id>`).
 */
export async function runDue(options: RunnerOptions): Promise<RunDueResult> {
  const now = options.now ?? new Date();
  const paths = options.paths ?? schedulerPaths(options.projectDir);
  const tasks = await loadTasks(paths.tasksFile);

  const lock = await acquireLock(paths.lockFile);
  if (!lock) return { skipped: true, runs: [], failures: 0, missed: 0 };

  try {
    await reclaimStaleRuns(paths.runsDir, now, options.runTimeoutMinutes ?? DEFAULT_RUN_TIMEOUT_MINUTES);

    const due = tasks
      .filter((task) => task.enabled && isDue(task, now))
      .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));

    const result: RunDueResult = { skipped: false, runs: [], failures: 0, missed: 0 };
    for (const task of due) {
      const outcome = isBeyondGrace(task, now, options.missedGraceMinutes ?? DEFAULT_MISSED_GRACE_MINUTES)
        ? await markMissed(task, paths, now, options.projectDir)
        : await executeTask(task, paths, options, "scheduled", now);
      result.runs.push(outcome);
      if (outcome.status === "error") result.failures += 1;
      if (outcome.status === "missed") result.missed += 1;
      await saveTasks(paths.tasksFile, tasks);
    }
    if (result.runs.length > 0) await pruneRuns(paths.runsDir, DEFAULT_KEEP_RUNS);
    return result;
  } finally {
    await lock.release();
  }
}

/** Execute one task immediately, without disturbing its schedule. */
export async function runTask(
  projectDir: string,
  taskId: string,
  options: Omit<RunnerOptions, "projectDir">,
): Promise<RunOutcome> {
  const now = options.now ?? new Date();
  const paths = options.paths ?? schedulerPaths(projectDir);
  const tasks = await loadTasks(paths.tasksFile);
  const task = findTask(tasks, taskId);
  if (!task) throw new TaskNotFoundError(`Task not found: ${taskId}`);

  const lock = await acquireLock(paths.lockFile);
  if (!lock) return { taskId: task.id, runId: "", status: "skipped" };

  try {
    await reclaimStaleRuns(paths.runsDir, now, options.runTimeoutMinutes ?? DEFAULT_RUN_TIMEOUT_MINUTES);
    return await executeTask(
      task,
      paths,
      { agents: options.agents, agent: options.agent, projectDir },
      "manual",
      now,
      false,
    );
  } finally {
    await lock.release();
  }
}

export function findTask(tasks: ScheduleTask[], id: string): ScheduleTask | undefined {
  const exact = tasks.find((task) => task.id === id);
  if (exact) return exact;
  const matches = tasks.filter((task) => task.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new TaskNotFoundError(`Task ID is ambiguous: ${id}`);
  return undefined;
}

async function executeTask(
  task: ScheduleTask,
  paths: SchedulerPaths,
  options: Pick<RunnerOptions, "agents" | "agent" | "projectDir">,
  trigger: Trigger,
  now: Date,
  advanceSchedule = true,
): Promise<RunOutcome> {
  const runId = createRunId(now);
  const run: RunRecord = {
    runId,
    taskId: task.id,
    trigger,
    startedAt: now.toISOString(),
    status: "running",
  };
  await writeRun(paths.runsDir, run);

  let agentId: string | undefined;
  try {
    const adapter = await (options.agents ?? builtInAgents).resolve(task.agent ?? options.agent);
    agentId = adapter.id;
    const result = await adapter.run({ task, run, projectDir: options.projectDir });
    const record: RunRecord = {
      ...run,
      agent: agentId,
      status: "success",
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      sessionFile: result.sessionFile,
      summary: result.summary,
    };
    await writeRun(paths.runsDir, record);
    await maybeNotify(paths, task, record, options.projectDir);
    if (advanceSchedule) advance(task, now);
    return { taskId: task.id, runId, status: "success" };
  } catch (error) {
    const record: RunRecord = {
      ...run,
      ...(agentId ? { agent: agentId } : {}),
      status: "error",
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    };
    await writeRun(paths.runsDir, record);
    await maybeNotify(paths, task, record, options.projectDir);
    if (advanceSchedule) advance(task, now);
    return { taskId: task.id, runId, status: "error" };
  }
}

async function markMissed(task: ScheduleTask, paths: SchedulerPaths, now: Date, projectDir: string): Promise<RunOutcome> {
  const runId = createRunId(now);
  const record: RunRecord = {
    runId,
    taskId: task.id,
    trigger: "scheduled",
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    status: "missed",
    exitCode: 1,
    error: "Planned time passed before any run claimed this task",
  };
  await writeRun(paths.runsDir, record);
  await maybeNotify(paths, task, record, projectDir);
  task.enabled = false;
  task.updatedAt = now.toISOString();
  return { taskId: task.id, runId, status: "missed" };
}

/**
 * Offers the finished run to the configured notification channels. Everything
 * here is best effort: config problems and delivery failures land on stderr
 * so a cron pass never fails because of them.
 */
async function maybeNotify(
  paths: SchedulerPaths,
  task: ScheduleTask,
  run: RunRecord,
  projectDir: string,
): Promise<void> {
  try {
    const config = await loadNotifyConfig(paths.dir);
    await dispatchNotifications(config, task, run, projectDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agents-cron] notification dispatch failed: ${reason}\n`);
  }
}

/**
 * A one-shot task is terminal after its first attempt: it succeeds, fails, or
 * misses, and never retries on its own. A recurring task moves to its next
 * occurrence measured from now, so missed periods collapse into one catch-up.
 */
function advance(task: ScheduleTask, now: Date): void {
  task.updatedAt = now.toISOString();
  if (task.schedule.kind === "once") {
    task.enabled = false;
    return;
  }
  const next = calculateNextRun(task.schedule, now);
  task.nextRunAt = next?.toISOString();
  if (!next) task.enabled = false;
}

function isBeyondGrace(task: ScheduleTask, now: Date, graceMinutes: number): boolean {
  if (task.schedule.kind !== "once") return false;
  const planned = new Date(task.schedule.runAt).getTime();
  if (Number.isNaN(planned)) return false;
  return now.getTime() - planned > graceMinutes * 60_000;
}
