import { resolve } from "node:path";
import { importLegacyStore } from "./migration.ts";
import { loadNotifyConfig } from "./notify/config.ts";
import { schedulerPaths } from "./paths.ts";
import { loadRegistry, updateRegistry } from "./registry.ts";
import { createTaskId } from "./runs.ts";
import { calculateNextRun, parseScheduleInput, type ScheduleInput } from "./scheduling.ts";
import { TaskNotFoundError } from "./runner.ts";
import type { ScheduleTask } from "./types.ts";

/**
 * Task management over the global Task Registry (ADR 0007). Every entry point
 * first runs the lazy legacy import for the project it touches, so a project
 * still carrying a v1 store joins the registry the moment any command
 * reaches it. "Local" is a view: `listTasks(cwd)` orders the registry with
 * the current project's tasks first.
 */

export type NewTaskInput = {
  prompt: string;
  schedule: ScheduleInput;
  name?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  tools?: string[];
  notify?: "always" | "error" | "never";
  /** Channel ids the task's runs notify; absent means every configured channel. */
  notifyTo?: string[];
};

/** The Project View: the current project's tasks first, then every other project grouped by path. */
export async function listTasks(projectDir: string): Promise<ScheduleTask[]> {
  await importLegacyStore(projectDir);
  const local = resolve(projectDir);
  const tasks = await loadRegistry();
  return tasks.sort((a, b) => {
    const aLocal = a.projectDir === local;
    const bLocal = b.projectDir === local;
    if (aLocal !== bLocal) return aLocal ? -1 : 1;
    if (!aLocal && a.projectDir !== b.projectDir) return a.projectDir.localeCompare(b.projectDir);
    return (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "");
  });
}

export async function addTask(
  projectDir: string,
  input: NewTaskInput,
  now = new Date(),
): Promise<ScheduleTask> {
  await importLegacyStore(projectDir);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Task prompt must not be empty");

  const schedule = parseScheduleInput(input.schedule);
  const notifyTo = normalizeNotifyTo(input.notifyTo);
  if (notifyTo) await warnUnknownChannels(projectDir, notifyTo);
  const task: ScheduleTask = {
    id: createTaskId(),
    projectDir: resolve(projectDir),
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    prompt,
    schedule,
    enabled: true,
    nextRunAt: initialNextRun(schedule, now),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.notify ? { notify: input.notify } : {}),
    ...(notifyTo ? { notifyTo } : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await updateRegistry((tasks) => [...tasks, task]);
  return task;
}

export async function setTaskEnabled(
  projectDir: string,
  id: string,
  enabled: boolean,
): Promise<ScheduleTask> {
  await importLegacyStore(projectDir);
  let updated: ScheduleTask | undefined;
  await updateRegistry((tasks) => {
    const task = requireTask(tasks, id);
    task.enabled = enabled;
    task.updatedAt = new Date().toISOString();
    updated = task;
    return tasks;
  });
  return updated!;
}

export async function removeTask(projectDir: string, id: string): Promise<void> {
  await importLegacyStore(projectDir);
  await updateRegistry((tasks) => {
    const task = requireTask(tasks, id);
    return tasks.filter((entry) => entry.id !== task.id);
  });
}

/** Removes every task bound to the project; returns how many were removed. */
export async function clearTasks(projectDir: string): Promise<number> {
  await importLegacyStore(projectDir);
  const local = resolve(projectDir);
  let removed = 0;
  await updateRegistry((tasks) => {
    removed = tasks.filter((task) => task.projectDir === local).length;
    return tasks.filter((task) => task.projectDir !== local);
  });
  return removed;
}

export function requireTask(tasks: ScheduleTask[], id: string): ScheduleTask {
  const exact = tasks.find((task) => task.id === id);
  if (exact) return exact;
  const matches = tasks.filter((task) => task.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new TaskNotFoundError(`Task ID is ambiguous: ${id}`);
  throw new TaskNotFoundError(`Task not found: ${id}`);
}

function initialNextRun(schedule: ScheduleTask["schedule"], now: Date): string | undefined {
  if (schedule.kind === "once") return schedule.runAt;
  return calculateNextRun(schedule, now)?.toISOString();
}

/** Trim, drop empties, dedupe — an empty result means "no routing", same as absent. */
function normalizeNotifyTo(ids?: string[]): string[] | undefined {
  if (!ids?.length) return undefined;
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  return unique.length ? unique : undefined;
}

/**
 * Catch channel typos now, not at the first 3 a.m. run: routing to an id
 * this project never configured would silently deliver nothing. Every
 * creator shares this check through addTask (CLI, Pi commands, the tool).
 */
async function warnUnknownChannels(projectDir: string, ids: string[]): Promise<void> {
  const config = await loadNotifyConfig(schedulerPaths(projectDir).dir);
  const known = new Set(config.channels.map((channel) => channel.id));
  for (const id of ids) {
    if (!known.has(id)) {
      process.stderr.write(`[agents-cron] no notification channel "${id}" in .agents/cron/config.json; runs will not reach it\n`);
    }
  }
}
