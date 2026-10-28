import { resolve } from "node:path";
import { importLegacyStore } from "./migration.ts";
import { loadNotifyConfig, normalizeChannelIds } from "./notify/config.ts";
import type { ChannelId } from "./notify/types.ts";
import { schedulerPaths } from "./paths.ts";
import { loadRegistry, updateRegistry } from "./registry.ts";
import { createTaskId } from "./runs.ts";
import { calculateNextRun, parseScheduleInput, type ScheduleInput } from "./scheduling.ts";
import { buildExportFile, type ExportFile, type ExportedTask } from "./task-export.ts";
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
  const notifyTo = normalizeChannelIds(input.notifyTo);
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

// --- Task export and import (ADR 0009) ---

export type ExportSelection = {
  /** Task ids (prefixes resolve as everywhere else); selects across the whole registry. */
  ids?: string[];
  /** Every project's tasks, not just the current project's. */
  all?: boolean;
};

/** Builds a Task Export: definitions only, identity and registry state stripped. */
export async function exportTasks(
  projectDir: string,
  selection: ExportSelection = {},
  now = new Date(),
): Promise<ExportFile> {
  await importLegacyStore(projectDir);
  const tasks = await loadRegistry();
  let chosen: ScheduleTask[];
  if (selection.ids?.length) {
    const picked = new Map<string, ScheduleTask>();
    for (const id of selection.ids) {
      const task = requireTask(tasks, id);
      picked.set(task.id, task);
    }
    chosen = [...picked.values()];
  } else if (selection.all) {
    chosen = tasks;
  } else {
    const local = resolve(projectDir);
    chosen = tasks.filter((task) => task.projectDir === local);
  }
  return buildExportFile(chosen, now);
}

export type ImportOptions = { now?: Date; dryRun?: boolean };

export type ImportReport = {
  created: ScheduleTask[];
  skipped: Array<{ entry: ExportedTask; reason: string }>;
  warnings: string[];
};

/**
 * Imports task definitions into a project: every entry becomes a fresh task
 * bound to `projectDir`, starting disabled so imported prompts can be
 * reviewed before they run. An entry whose name, prompt, and schedule all
 * match an existing task of the project is skipped as a duplicate — the
 * same file imported twice adds nothing. One registry write covers the
 * whole batch: all created or none.
 */
export async function importTasks(
  projectDir: string,
  entries: ExportedTask[],
  options: ImportOptions = {},
): Promise<ImportReport> {
  await importLegacyStore(projectDir);
  const now = options.now ?? new Date();
  const target = resolve(projectDir);

  const warnings: string[] = [];
  const channelIds = [...new Set(entries.flatMap((entry) => entry.notifyTo ?? []))];
  warnings.push(...(await unknownChannelWarnings(projectDir, channelIds)));
  for (const entry of entries) {
    if (entry.schedule.kind === "once" && new Date(entry.schedule.runAt).getTime() <= now.getTime()) {
      warnings.push(
        `${importLabel(entry)}: runAt is in the past — once enabled, the run will be recorded as missed`,
      );
    }
  }

  const report: ImportReport = { created: [], skipped: [], warnings };
  const plan = (registry: ScheduleTask[]): ScheduleTask[] => {
    const existing = registry.filter((task) => task.projectDir === target);
    for (const entry of entries) {
      const clash = existing.find((task) => sameDefinition(task, entry));
      if (clash) {
        report.skipped.push({ entry, reason: `duplicate of ${clash.id}` });
        continue;
      }
      const task: ScheduleTask = {
        id: createTaskId(),
        projectDir: target,
        ...(entry.name ? { name: entry.name } : {}),
        prompt: entry.prompt,
        schedule: entry.schedule,
        enabled: false,
        nextRunAt: initialNextRun(entry.schedule, now),
        ...(entry.agent ? { agent: entry.agent } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.thinking ? { thinking: entry.thinking } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.tools?.length ? { tools: entry.tools } : {}),
        ...(entry.notify ? { notify: entry.notify } : {}),
        ...(entry.notifyTo?.length ? { notifyTo: normalizeChannelIds(entry.notifyTo) } : {}),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      report.created.push(task);
      existing.push(task);
    }
    return [...registry, ...report.created];
  };

  if (options.dryRun) plan(await loadRegistry());
  else await updateRegistry(plan);
  return report;
}

function importLabel(entry: ExportedTask): string {
  return entry.name ?? (entry.prompt.length > 40 ? `${entry.prompt.slice(0, 40)}…` : entry.prompt);
}

/** The duplicate key (ADR 0009): name, prompt, and schedule must all match. */
function sameDefinition(task: ScheduleTask, entry: ExportedTask): boolean {
  return task.name === entry.name && task.prompt === entry.prompt && sameSchedule(task.schedule, entry.schedule);
}

function sameSchedule(a: ScheduleTask["schedule"], b: ScheduleTask["schedule"]): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "once" && b.kind === "once") return a.runAt === b.runAt;
  if (a.kind === "interval" && b.kind === "interval") return a.everyMs === b.everyMs;
  if (a.kind === "cron" && b.kind === "cron") return a.expression === b.expression && a.timezone === b.timezone;
  return false;
}

function initialNextRun(schedule: ScheduleTask["schedule"], now: Date): string | undefined {
  if (schedule.kind === "once") return schedule.runAt;
  return calculateNextRun(schedule, now)?.toISOString();
}

/**
 * Catch channel typos now, not at the first 3 a.m. run: routing to an id
 * this project never configured would silently deliver nothing. Every
 * creator shares this check through addTask (CLI, Pi commands, the tool).
 */
async function warnUnknownChannels(projectDir: string, ids: ChannelId[]): Promise<void> {
  for (const warning of await unknownChannelWarnings(projectDir, ids)) {
    process.stderr.write(`[agents-cron] ${warning}\n`);
  }
}

/** The warning lines behind warnUnknownChannels, collected for import reports. */
export async function unknownChannelWarnings(projectDir: string, ids: ChannelId[]): Promise<string[]> {
  if (!ids.length) return [];
  const config = await loadNotifyConfig(schedulerPaths(projectDir).dir);
  const known = new Set(config.channels.map((channel) => channel.id));
  return ids
    .filter((id) => !known.has(id))
    .map((id) => `no notification channel "${id}" in .agents/cron/config.json; runs will not reach it`);
}
