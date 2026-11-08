import type { RunRecord, ScheduleTask } from "./types.ts";

/**
 * The one vocabulary for printing a task, a run, and a schedule.
 *
 * Four surfaces read the same store — the CLI, the `schedule_task` tool, the
 * slash commands (and their completions), and the dashboard — and an agent
 * moving between them must not have to learn a second dialect for the same
 * field. So the interval text (`30m`, never `300000ms`), the timestamp shape
 * (compact ISO 8601), and the task/run line live here and nowhere else; a
 * surface with a different need passes an option instead of writing a sibling
 * formatter. Two of those had already drifted before this module existed.
 */

/** 30m, 2h, 1d…; sub-second oddities keep their milliseconds. */
export function formatInterval(ms: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [size, suffix] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${suffix}`;
  }
  return `${ms}ms`;
}

/** Compact ISO 8601: whole seconds drop the `.000`, so lines stay scannable and diffable. */
export function stamp(iso?: string): string {
  return iso === undefined ? "never" : iso.replace(/\.000Z$/, "Z");
}

/** The stored schedule as one clause: `every 30m`, `cron 0 9 * * 1-5`, `once <iso>`. */
export function formatSchedule(task: ScheduleTask): string {
  if (task.schedule.kind === "interval") return `every ${formatInterval(task.schedule.everyMs)}`;
  if (task.schedule.kind === "cron") {
    return `cron ${task.schedule.expression}${task.schedule.timezone ? ` (${task.schedule.timezone})` : ""}`;
  }
  return `once ${stamp(task.schedule.runAt)}`;
}

export function firstLine(text: string, width = 120): string {
  const line = text.split("\n")[0].trim();
  return line.length > width ? `${line.slice(0, width)}…` : line;
}

/** A prompt cut to one glanceable clause — used wherever a name may be absent. */
export function previewPrompt(prompt: string, width = 40): string {
  return prompt.length > width ? `${prompt.slice(0, width)}…` : prompt;
}

export type TaskLineOptions = {
  /**
   * The newest run record, when the caller already read the project's runs.
   * Without it the line falls back to the registry's own `lastRunAt`, so a
   * surface that cannot afford the read never claims a task was "never run".
   */
  latestRun?: RunRecord;
  /** Appended right after the schedule clause, e.g. ` ⚠ missing directory`. */
  suffix?: string;
};

/** One task on one line: id, state, name, schedule, next run, latest outcome. */
export function formatTaskLine(task: ScheduleTask, options: TaskLineOptions = {}): string {
  const state = task.enabled ? "enabled" : "disabled";
  const latest = options.latestRun;
  const last = latest
    ? `last ${latest.status} at ${stamp(latest.finishedAt ?? latest.startedAt)}`
    : task.lastRunAt
      ? `last ${task.lastStatus ?? "run"} at ${stamp(task.lastRunAt)}`
      : "never run";
  return `${task.id} [${state}] ${task.name ?? "-"} — ${formatSchedule(task)}${options.suffix ?? ""} — next ${stamp(task.nextRunAt)} — ${last}`;
}

/** Verbose sibling of formatTaskLine: every scheduling fact, then the prompt. */
export function formatTaskDetail(task: ScheduleTask): string {
  const lines = [
    `${task.id} [${task.enabled ? "enabled" : "disabled"}] ${task.name ?? "-"}`,
    `project: ${task.projectDir}`,
    `schedule: ${formatSchedule(task)}`,
    `next run: ${stamp(task.nextRunAt)}`,
  ];
  if (task.lastRunAt) {
    lines.push(`last run: ${stamp(task.lastRunAt)}${task.lastStatus ? ` (${task.lastStatus})` : ""}`);
  }
  const counters = [
    task.successCount !== undefined ? `${task.successCount} success` : undefined,
    task.errorCount !== undefined ? `${task.errorCount} error` : undefined,
    task.missedCount !== undefined ? `${task.missedCount} missed` : undefined,
  ].filter(Boolean);
  if (counters.length > 0) lines.push(`runs: ${counters.join(", ")}`);
  if (task.agent) lines.push(`agent: ${task.agent}`);
  if (task.model) lines.push(`model: ${task.model}`);
  if (task.thinking) lines.push(`thinking: ${task.thinking}`);
  if (task.cwd) lines.push(`cwd: ${task.cwd}`);
  if (task.tools?.length) lines.push(`tools: ${task.tools.join(", ")}`);
  if (task.notify) lines.push(`notify: ${task.notify}`);
  if (task.notifyTo?.length) lines.push(`notify to: ${task.notifyTo.join(", ")}`);
  lines.push(`created: ${stamp(task.createdAt)}  updated: ${stamp(task.updatedAt)}`);
  lines.push("", "prompt:", task.prompt);
  return lines.join("\n");
}

export type RunLineOptions = {
  /** Append the first line of `error` (default true — why a run failed is not optional). */
  error?: boolean;
  /** Append the summary and the session path, each indented on its own line. */
  full?: boolean;
  /** Append the session path inline — for a surface that opens sessions by path. */
  session?: boolean;
};

/** One run on one line: id, status, trigger, when, and why it failed. */
export function formatRunLine(run: RunRecord, options: RunLineOptions = {}): string {
  const parts = [`${run.runId} [${run.status}] ${run.trigger} — ${stamp(run.finishedAt ?? run.startedAt)}`];
  if (options.error !== false && run.error) parts.push(`— ${firstLine(run.error)}`);
  if (options.full && run.summary) parts.push(`\n  ${firstLine(run.summary)}`);
  if (options.full && run.sessionFile) parts.push(`\n  session: ${run.sessionFile}`);
  else if (options.session && run.sessionFile) parts.push(`— ${run.sessionFile}`);
  return parts.join(" ");
}
