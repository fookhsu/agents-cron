import type { RunNotification } from "./types.ts";

const ICONS: Record<RunNotification["status"], string> = {
  success: "✓",
  error: "✗",
  missed: "○",
  skipped: "–",
};

/** One-line human summary, used as the email subject and the text webhook body head. */
export function subjectOf(n: RunNotification): string {
  const name = n.taskName ?? n.taskId;
  return `${ICONS[n.status]} ${name} ${n.status}`;
}

/** Plain-text body: everything a human needs to triage the run. */
export function bodyOf(n: RunNotification): string {
  const lines = [
    `project:  ${n.project}`,
    `task:     ${n.taskName ? `${n.taskName} (${n.taskId})` : n.taskId}`,
    `run:      ${n.runId} (${n.trigger})`,
    ...(n.agent ? [`agent:    ${n.agent}`] : []),
    `status:   ${n.status}${n.exitCode !== undefined ? ` (exit ${n.exitCode})` : ""}`,
    `started:  ${n.startedAt}`,
    ...(n.finishedAt ? [`finished: ${n.finishedAt}`] : []),
    ...(n.summary ? ["", n.summary] : []),
    ...(n.error ? ["", `error: ${n.error}`] : []),
    ...(n.sessionFile ? ["", `session: ${n.sessionFile}`] : []),
  ];
  return lines.join("\n");
}
