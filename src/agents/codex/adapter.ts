import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { schedulerPaths } from "../../paths.ts";
import type { RunRecord, ScheduleTask } from "../../types.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "../types.ts";
import { captureOutput, formatScheduledPrompt, lastLines, resolveBinary, summarize } from "../run-utils.ts";

/** Names the `codex` executable the adapter spawns, for cron's minimal PATH. */
export const CODEX_BIN_ENV = "AGENTS_CRON_CODEX_BIN";

/**
 * Agent adapter for Codex: one fresh, headless `codex exec` run per Task Run,
 * with the final message captured via `--output-last-message` and the JSONL
 * event stream kept as a diagnostic tail.
 *
 * Like the Pi and Claude Code adapters, it drives the user's installed `codex`
 * CLI rather than an SDK, so credentials and model access stay between the
 * user and Codex. Codex keeps its own transcript; this adapter writes a JSON
 * record under `.pi/scheduler/sessions/<taskId>/<runId>.json`.
 */
export function createCodexAdapter(): AgentAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    run: runInTaskSession,
  };
}

async function runInTaskSession({
  task,
  run,
  projectDir,
}: AgentRunRequest): Promise<AgentRunResult> {
  const cwd = task.cwd ? resolve(projectDir, task.cwd) : projectDir;
  const sessionFile = codexSessionFile(projectDir, task.id, run.runId);
  await mkdir(dirname(sessionFile), { recursive: true });

  const bin = resolveCodexBinary();
  const lastMessageFile = join(tmpdir(), `agents-cron-codex-${run.runId}.txt`);
  try {
    const { code, stdout, stderr } = await captureOutput(bin, codexArgs(task, run, lastMessageFile), cwd);
    const lastMessage = await readFile(lastMessageFile, "utf8").catch(() => "");
    const result = parseCodexResult(stdout, code, stderr, lastMessage);
    await writeSessionFile(sessionFile, result.raw);
    return { sessionFile, summary: summarize(result.text) };
  } catch (error) {
    // A failed run still gets its record, so the run file and session record
    // explain what Codex reported.
    if (error instanceof CodexRunError) {
      await writeSessionFile(sessionFile, error.result);
      error.message = `${error.message} (result recorded in ${sessionFile})`;
    }
    throw error;
  } finally {
    await rm(lastMessageFile, { force: true }).catch(() => undefined);
  }
}

async function writeSessionFile(sessionFile: string, raw: Record<string, unknown>): Promise<void> {
  await writeFile(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await chmod(sessionFile, 0o600).catch(() => undefined);
}

/**
 * The argv for one Task Run. `exec` keeps the run non-interactive and its
 * approval policy fixed at "never", so the sandbox decides what the run may
 * touch: a task without `tools` runs `read-only`, a task with `tools` runs
 * `workspace-write` — Codex has no per-tool allowlist, and a headless run
 * must never be able to block on an approval prompt. `thinking` has no Codex
 * equivalent and is ignored.
 */
export function codexArgs(task: ScheduleTask, run: RunRecord, lastMessageFile: string): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--output-last-message",
    lastMessageFile,
    "--sandbox",
    task.tools?.length ? "workspace-write" : "read-only",
    ...(task.model ? ["--model", task.model] : []),
    formatScheduledPrompt(task, run),
  ];
}

/** The run's session record: Codex owns the real transcript; we keep the final message and event tail. */
export function codexSessionFile(projectDir: string, taskId: string, runId: string): string {
  return join(schedulerPaths(projectDir).sessionsDir, taskId, `${runId}.json`);
}

/** Finds the `codex` executable: an explicit override first, then $PATH. */
export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBinary(env, CODEX_BIN_ENV, "codex", ["codex.cmd", "codex.exe", "codex"]);
}

type CodexResult = { raw: Record<string, unknown>; text: string };

/**
 * Judges one `codex exec` run from its event stream, exit code, and captured
 * final message. A non-zero exit is a failed run; the diagnostic payload
 * (final message if any, plus the tail of the JSONL events) is kept for the
 * record even then. A zero exit with no message anywhere falls back to the
 * last agent message in the event stream before giving up.
 */
export function parseCodexResult(
  stdout: string,
  code: number | null,
  stderr: string,
  lastMessage: string,
): CodexResult {
  const events = eventTail(stdout);
  const message = lastMessage.trim() || lastAgentMessage(events) || "";
  const raw: Record<string, unknown> = {
    type: "codex-run",
    exitCode: code,
    lastMessage: message,
    events,
  };

  const detail = stderr.trim() ? `: ${lastLines(stderr)}` : "";
  if (message && code === 0) return { raw, text: message };
  throw new CodexRunError(
    message
      ? `codex exited with ${code}${detail}`
      : `codex exited with ${code} without a final message${detail}`,
    raw,
  );
}

/** A failed run whose diagnostic payload is still worth keeping in the run record. */
export class CodexRunError extends Error {
  readonly result: Record<string, unknown>;

  constructor(message: string, result: Record<string, unknown>) {
    super(message);
    this.result = result;
  }
}

/** The last few JSONL events from the exec stream, parsed where possible. */
function eventTail(stdout: string, count = 5): unknown[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return line;
      }
    });
}

/** The text of the last completed agent message in the event stream, if any. */
function lastAgentMessage(events: unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object") continue;
    const item = (event as { item?: unknown }).item;
    if (!item || typeof item !== "object") continue;
    const { type, text } = item as { type?: unknown; text?: unknown };
    if (type === "agent_message" && typeof text === "string" && text.trim()) return text.trim();
  }
  return undefined;
}
