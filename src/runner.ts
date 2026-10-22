import { existsSync } from "node:fs";
import { acquireLock } from "./lock.ts";
import { agents as builtInAgents, type AgentRegistry } from "./agents/registry.ts";
import { importLegacyStore } from "./migration.ts";
import { dispatchNotifications } from "./notify/dispatch.ts";
import { loadNotifyConfig } from "./notify/config.ts";
import { schedulerPaths } from "./paths.ts";
import { loadRegistry, updateRegistry } from "./registry.ts";
import { createRunId, pruneRuns, reclaimStaleRuns, writeRun } from "./runs.ts";
import { writeRunReport } from "./reports.ts";
import { calculateNextRun, isDue } from "./scheduling.ts";
import type { RunRecord, ScheduleTask, Trigger } from "./types.ts";

const DEFAULT_RUN_TIMEOUT_MINUTES = 30;
const DEFAULT_MISSED_GRACE_MINUTES = 5;
const DEFAULT_KEEP_RUNS = 20;

export type RunnerOptions = {
  /**
   * The project a legacy `run-due` invocation stands in: due tasks are
   * filtered to this project's binding. Undefined means global mode — every
   * project in the registry, group by group under each project's run lock.
   */
  projectDir?: string;
  /** Agent adapter registry; defaults to the built-in agents. */
  agents?: AgentRegistry;
  /** Agent for tasks that name none; defaults to the registry's default. */
  agent?: string;
  now?: Date;
  runTimeoutMinutes?: number;
  missedGraceMinutes?: number;
};

export type RunOutcome = {
  taskId: string;
  runId: string;
  status: RunRecord["status"];
};

export type RunDueResult = {
  /** Every due group was owned by another live invocation, so nothing was attempted. */
  skipped: boolean;
  runs: RunOutcome[];
  failures: number;
  missed: number;
};

export class TaskNotFoundError extends Error {}

/**
 * The Task Runner: one idempotent pass over due tasks. Callers invoke it from
 * cron (`run-due`, optionally filtered to one project) or directly for a
 * single task (`run <id>`, resolved across the whole registry). Scheduling
 * state lives in the registry; run artifacts stay in each task's project.
 */
export async function runDue(options: RunnerOptions): Promise<RunDueResult> {
  const now = options.now ?? new Date();
  if (options.projectDir) await importLegacyStore(options.projectDir);

  const tasks = await loadRegistry();
  const scoped = options.projectDir ? tasks.filter((task) => task.projectDir === options.projectDir) : tasks;
  const due = scoped
    .filter((task) => task.enabled && isDue(task, now))
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));

  const result: RunDueResult = { skipped: false, runs: [], failures: 0, missed: 0 };
  const groups = new Map<string, ScheduleTask[]>();
  for (const task of due) {
    const group = groups.get(task.projectDir) ?? [];
    group.push(task);
    groups.set(task.projectDir, group);
  }

  let attempted = 0;
  for (const [projectDir, group] of groups) {
    if (!existsSync(projectDir)) {
      // The run lock would recreate the directory; error the group in the
      // registry instead, where artifacts have nowhere to live anyway.
      for (const task of group) {
        await reportMissingProject(task, now);
        result.runs.push({ taskId: task.id, runId: "", status: "error" });
        result.failures += 1;
      }
      continue;
    }
    const paths = schedulerPaths(projectDir);
    const lock = await acquireLock(paths.lockFile);
    if (!lock) continue; // another live runner owns this project
    attempted += 1;
    try {
      await reclaimStaleRuns(paths.runsDir, now, options.runTimeoutMinutes ?? DEFAULT_RUN_TIMEOUT_MINUTES);
      for (const task of group) {
        const outcome = isBeyondGrace(task, now, options.missedGraceMinutes ?? DEFAULT_MISSED_GRACE_MINUTES)
          ? await markMissed(task, now)
          : await executeTask(task, options, "scheduled", now);
        result.runs.push(outcome);
        if (outcome.status === "error") result.failures += 1;
        if (outcome.status === "missed") result.missed += 1;
      }
      await pruneRuns(paths.runsDir, paths.reportsDir, DEFAULT_KEEP_RUNS);
    } finally {
      await lock.release();
    }
  }
  result.skipped = due.length > 0 && attempted === 0;
  return result;
}

/** Execute one task immediately, without disturbing its schedule. */
export async function runTask(
  projectDir: string,
  taskId: string,
  options: Omit<RunnerOptions, "projectDir">,
): Promise<RunOutcome> {
  const now = options.now ?? new Date();
  await importLegacyStore(projectDir);

  const tasks = await loadRegistry();
  const task = findTask(tasks, taskId);
  if (!task) throw new TaskNotFoundError(`Task not found: ${taskId}`);

  if (!existsSync(task.projectDir)) {
    const outcome = await reportMissingProject(task, now);
    return { taskId: task.id, runId: "", status: outcome };
  }

  const paths = schedulerPaths(task.projectDir);
  const lock = await acquireLock(paths.lockFile);
  if (!lock) return { taskId: task.id, runId: "", status: "skipped" };

  try {
    await reclaimStaleRuns(paths.runsDir, now, options.runTimeoutMinutes ?? DEFAULT_RUN_TIMEOUT_MINUTES);
    return await executeTask(task, { agents: options.agents, agent: options.agent }, "manual", now, false);
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
  options: Pick<RunnerOptions, "agents" | "agent">,
  trigger: Trigger,
  now: Date,
  advanceSchedule = true,
): Promise<RunOutcome> {
  const paths = schedulerPaths(task.projectDir);
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
    const result = await adapter.run({ task, run, projectDir: task.projectDir });
    const record: RunRecord = {
      ...run,
      agent: agentId,
      status: "success",
      finishedAt: now.toISOString(),
      exitCode: 0,
      sessionFile: result.sessionFile,
      summary: result.summary,
    };
    await writeRun(paths.runsDir, record);
    await writeRunReport(paths.reportsDir, task, record);
    await maybeNotify(paths.dir, task, record);
    await updateTaskState(task.id, (stored) => {
      stored.lastRunAt = now.toISOString();
      stored.lastStatus = "success";
      stored.successCount = (stored.successCount ?? 0) + 1;
      if (advanceSchedule) advance(stored, now);
      else stored.updatedAt = now.toISOString();
    });
    return { taskId: task.id, runId, status: "success" };
  } catch (error) {
    const record: RunRecord = {
      ...run,
      ...(agentId ? { agent: agentId } : {}),
      status: "error",
      finishedAt: now.toISOString(),
      exitCode: 1,
      error: error instanceof Error ? error.message : String(error),
    };
    await writeRun(paths.runsDir, record);
    await writeRunReport(paths.reportsDir, task, record);
    await maybeNotify(paths.dir, task, record);
    await updateTaskState(task.id, (stored) => {
      stored.lastRunAt = now.toISOString();
      stored.lastStatus = "error";
      stored.errorCount = (stored.errorCount ?? 0) + 1;
      if (advanceSchedule) advance(stored, now);
      else stored.updatedAt = now.toISOString();
    });
    return { taskId: task.id, runId, status: "error" };
  }
}

async function markMissed(task: ScheduleTask, now: Date): Promise<RunOutcome> {
  const runId = createRunId(now);
  if (existsSync(task.projectDir)) {
    const paths = schedulerPaths(task.projectDir);
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
    await writeRunReport(paths.reportsDir, task, record);
    await maybeNotify(paths.dir, task, record);
  }
  await updateTaskState(task.id, (stored) => {
    stored.lastRunAt = now.toISOString();
    stored.lastStatus = "missed";
    stored.missedCount = (stored.missedCount ?? 0) + 1;
    stored.enabled = false;
    stored.updatedAt = now.toISOString();
  });
  return { taskId: task.id, runId, status: "missed" };
}

/** Records a run failure for a task whose project directory is gone. */
async function reportMissingProject(task: ScheduleTask, now: Date): Promise<"error"> {
  const error = `Project directory no longer exists: ${task.projectDir}`;
  await updateTaskState(task.id, (stored) => {
    stored.lastRunAt = now.toISOString();
    stored.lastStatus = "error";
    stored.errorCount = (stored.errorCount ?? 0) + 1;
    stored.updatedAt = now.toISOString();
    // Recurring tasks move on to their next occurrence (staying enabled, per
    // ADR 0007 Q4); a one-shot task is left untouched for the grace window.
    if (stored.schedule.kind !== "once") advance(stored, now);
  });
  process.stderr.write(`[agents-cron] task ${task.id}: ${error}\n`);
  return "error";
}

/** Applies a registry-state change to one task under the registry lock. */
async function updateTaskState(taskId: string, apply: (task: ScheduleTask) => void): Promise<void> {
  await updateRegistry((tasks) => {
    const task = tasks.find((entry) => entry.id === taskId);
    if (task) apply(task);
    return tasks;
  });
}

/**
 * Offers the finished run to the configured notification channels. Everything
 * here is best effort: config problems and delivery failures land on stderr
 * so a cron pass never fails because of them.
 */
async function maybeNotify(storeDir: string, task: ScheduleTask, run: RunRecord): Promise<void> {
  try {
    const config = await loadNotifyConfig(storeDir);
    await dispatchNotifications(config, task, run, task.projectDir);
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
