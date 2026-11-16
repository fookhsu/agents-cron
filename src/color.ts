/**
 * ANSI color for the CLI, and nowhere else.
 *
 * Four surfaces share the plain-text vocabulary in format.ts, and three of
 * them — the slash commands, the `schedule_task` tool, and anything piping
 * the CLI — need bytes without escape codes to parse. So color is opt-in per
 * process: only the CLI binary flips it on, only for a real terminal, only
 * without NO_COLOR, and never when the caller injected a stdout (tests, SDK
 * hosts). Every span helper below is the identity function until then, so
 * piped output stays byte-identical to the plain text agents already parse.
 */

let enabled = false;

/** The CLI's gate: a real terminal, no NO_COLOR, and no injected stdout. */
export function colorsEnabledFor(
  stream: { isTTY?: boolean } | undefined,
  env: { NO_COLOR?: string },
  injectedStdout: boolean,
): boolean {
  return !injectedStdout && stream?.isTTY === true && env.NO_COLOR === undefined;
}

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

function span(code: number, text: string): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/** Quiet supporting text: schedules, timestamps, paths, summaries. */
export const dim = (text: string): string => span(2, text);
/** Task names and project labels — the scan anchors. */
export const bold = (text: string): string => span(1, text);
/** Enabled state. */
export const green = (text: string): string => span(32, text);
/** Warnings: disabled state, missing directory. */
export const yellow = (text: string): string => span(33, text);
/** Task ids and project headers. */
export const cyan = (text: string): string => span(36, text);
