import { Cron } from "croner";
import type { ChannelId, NotifyLevel } from "./notify/types.ts";
import { MIN_INTERVAL_MS, normalizeCronExpression, type ScheduleDefinition } from "./scheduling.ts";
import type { ScheduleTask } from "./types.ts";

/**
 * A Task Export (ADR 0009): a versioned JSON file of task definitions. Only
 * the definition travels — id, projectDir, enabled, and every registry state
 * field stay home, so importing is always "new task bound here, starts
 * disabled", never a state restore.
 */

export const EXPORT_VERSION = 1;

/** The portable half of a ScheduleTask: what an export carries per task. */
export type ExportedTask = {
  name?: string;
  prompt: string;
  schedule: ScheduleDefinition;
  agent?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  tools?: string[];
  notify?: NotifyLevel;
  notifyTo?: ChannelId[];
};

export type ExportFile = {
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  tasks: ExportedTask[];
};

/** Strips identity and registry state, keeping only the definition. */
export function toExportedTask(task: ScheduleTask): ExportedTask {
  return {
    ...(task.name ? { name: task.name } : {}),
    prompt: task.prompt,
    schedule: task.schedule,
    ...(task.agent ? { agent: task.agent } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.thinking ? { thinking: task.thinking } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(task.tools?.length ? { tools: task.tools } : {}),
    ...(task.notify ? { notify: task.notify } : {}),
    ...(task.notifyTo?.length ? { notifyTo: task.notifyTo } : {}),
  };
}

export function buildExportFile(tasks: ScheduleTask[], now: Date): ExportFile {
  return { version: EXPORT_VERSION, exportedAt: now.toISOString(), tasks: tasks.map(toExportedTask) };
}

/**
 * Strict parse, in the registry's spirit: a bad file throws whole, never
 * silently drops entries. Schedules are validated as deeply as `add` — a
 * five-field cron gains its second field, a once timestamp is canonicalised —
 * so an import can never store a schedule `add` would have rejected.
 */
export function parseExportFile(raw: string): ExportFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Task export is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Task export must be a JSON object");
  const file = parsed as Partial<ExportFile> & { tasks?: unknown };

  if (file.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported task export version: ${String(file.version)} — expected ${EXPORT_VERSION}`);
  }
  if (typeof file.exportedAt !== "string") throw new Error("Task export requires an exportedAt timestamp");
  if (!Array.isArray(file.tasks)) throw new Error("Task export field tasks must be an array");

  return { version: EXPORT_VERSION, exportedAt: file.exportedAt, tasks: file.tasks.map(parseExportedTask) };
}

function parseExportedTask(value: unknown, index: number): ExportedTask {
  const at = `task ${index + 1}`;
  if (!value || typeof value !== "object") throw new Error(`${at}: must be an object`);
  const entry = value as Record<string, unknown>;

  if (typeof entry.prompt !== "string" || !entry.prompt.trim()) {
    throw new Error(`${at}: prompt must be a non-empty string`);
  }
  const schedule = parseExportedSchedule(entry.schedule, at);

  const name = optionalString(entry.name, "name", at);
  const agent = optionalString(entry.agent, "agent", at);
  const model = optionalString(entry.model, "model", at);
  const thinking = optionalString(entry.thinking, "thinking", at);
  const cwd = optionalString(entry.cwd, "cwd", at);

  let tools: string[] | undefined;
  if (entry.tools !== undefined) {
    if (!Array.isArray(entry.tools) || !entry.tools.every((tool) => typeof tool === "string")) {
      throw new Error(`${at}: tools must be an array of strings`);
    }
    const cleaned = entry.tools.map((tool) => (tool as string).trim()).filter(Boolean);
    if (cleaned.length) tools = cleaned;
  }

  let notify: NotifyLevel | undefined;
  if (entry.notify !== undefined) {
    if (entry.notify !== "always" && entry.notify !== "error" && entry.notify !== "never") {
      throw new Error(`${at}: notify must be one of: always, error, never`);
    }
    notify = entry.notify;
  }

  let notifyTo: ChannelId[] | undefined;
  if (entry.notifyTo !== undefined) {
    if (!Array.isArray(entry.notifyTo) || !entry.notifyTo.every((id) => typeof id === "string")) {
      throw new Error(`${at}: notifyTo must be an array of channel ids`);
    }
    const cleaned = [...new Set(entry.notifyTo.map((id) => (id as string).trim()).filter(Boolean))];
    if (cleaned.length) notifyTo = cleaned;
  }

  return {
    ...(name ? { name } : {}),
    prompt: entry.prompt.trim(),
    schedule,
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(cwd ? { cwd } : {}),
    ...(tools ? { tools } : {}),
    ...(notify ? { notify } : {}),
    ...(notifyTo ? { notifyTo } : {}),
  };
}

function optionalString(value: unknown, field: string, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${at}: ${field} must be a non-empty string`);
  return value.trim();
}

function parseExportedSchedule(value: unknown, at: string): ScheduleDefinition {
  if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") {
    throw new Error(`${at}: schedule.kind must be once, interval, or cron`);
  }
  const schedule = value as { kind: string; runAt?: unknown; everyMs?: unknown; expression?: unknown; timezone?: unknown };

  if (schedule.kind === "once") {
    const runAt = new Date(String(schedule.runAt));
    if (Number.isNaN(runAt.getTime())) {
      throw new Error(`${at}: schedule.runAt must be an ISO 8601 timestamp like 2026-10-29T09:00:00Z`);
    }
    return { kind: "once", runAt: runAt.toISOString() };
  }

  if (schedule.kind === "interval") {
    const everyMs = schedule.everyMs;
    if (typeof everyMs !== "number" || !Number.isInteger(everyMs) || everyMs < MIN_INTERVAL_MS) {
      throw new Error(`${at}: schedule.everyMs must be an integer of at least 1 minute (60000)`);
    }
    return { kind: "interval", everyMs };
  }

  if (schedule.kind === "cron") {
    if (typeof schedule.expression !== "string" || !schedule.expression.trim()) {
      throw new Error(`${at}: schedule.expression must be a non-empty string`);
    }
    const timezone = schedule.timezone === undefined ? undefined : optionalString(schedule.timezone, "schedule.timezone", at);
    let expression: string;
    try {
      expression = normalizeCronExpression(schedule.expression);
      new Cron(expression, { timezone });
    } catch (error) {
      throw new Error(`${at}: ${(error as Error).message}`);
    }
    return { kind: "cron", expression, ...(timezone ? { timezone } : {}) };
  }

  throw new Error(`${at}: schedule.kind must be once, interval, or cron`);
}
