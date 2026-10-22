import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord, ScheduleTask } from "./types.ts";

/**
 * Per-run Markdown reports (ADR 0007 Q&A follow-up): every terminal run —
 * success, error, or missed — leaves a human-readable document next to its
 * run record, at `<project>/.agents/cron/reports/<taskId>/<runId>.md`.
 * Reports are artifacts: metadata plus the full summary, never an inline
 * transcript (the session file is linked instead). `--notify` levels never
 * gate them; pruning removes them together with their run records.
 */
export async function writeRunReport(
  reportsDir: string,
  task: ScheduleTask,
  run: RunRecord,
): Promise<void> {
  await mkdir(join(reportsDir, task.id), { recursive: true });
  await writeFile(join(reportsDir, task.id, `${run.runId}.md`), render(task, run), "utf8");
}

function render(task: ScheduleTask, run: RunRecord): string {
  const lines: string[] = [
    `# Run report: ${task.name ?? task.id}`,
    "",
    `- Task: \`${task.id}\`${task.name ? ` (${task.name})` : ""}`,
    `- Project: ${task.projectDir}`,
    `- Run: \`${run.runId}\``,
    `- Trigger: ${run.trigger}`,
    `- Status: ${run.status}`,
    `- Started: ${run.startedAt}`,
    ...(run.finishedAt ? [`- Finished: ${run.finishedAt}`] : []),
    ...(run.agent ? [`- Agent: ${run.agent}`] : []),
    ...(run.sessionFile ? [`- Session: ${relativeSessionHint(run.sessionFile)}`] : []),
    "",
  ];
  if (run.summary) {
    lines.push("## Summary", "", run.summary, "");
  }
  if (run.error) {
    lines.push("## Error", "", run.error, "");
  }
  return lines.join("\n");
}

/** Session paths are stored absolute; show the tail so the line stays readable. */
function relativeSessionHint(sessionFile: string): string {
  const marker = ".agents/cron/sessions/";
  const at = sessionFile.indexOf(marker);
  return at >= 0 ? sessionFile.slice(at) : sessionFile;
}
