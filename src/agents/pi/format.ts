import type { RunRecord, ScheduleTask } from "../../types.ts";

/**
 * Display formatting shared by the slash-command handlers and their argument
 * completions. Pure functions over task/run records — no store access.
 */

export function previewPrompt(prompt: string): string {
  return prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;
}

export function formatTask(task: ScheduleTask): string {
  return `${task.id} [${task.enabled ? "enabled" : "disabled"}] ${task.name ?? "-"} — ${formatSchedule(task)} — next ${formatDate(task.nextRunAt)}`;
}

export function formatRun(run: RunRecord): string {
  const when = run.finishedAt ?? run.startedAt;
  return `${run.runId} [${run.status}] ${run.trigger} — ${formatDate(when)}${run.sessionFile ? ` — ${run.sessionFile}` : ""}`;
}

export function formatSchedule(task: ScheduleTask): string {
  if (task.schedule.kind === "interval") return `every ${task.schedule.everyMs}ms`;
  if (task.schedule.kind === "cron") return `cron ${task.schedule.expression}`;
  return `once ${task.schedule.runAt}`;
}

export function formatDate(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : "never";
}
