import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { schedulerPaths } from "../../paths.ts";
import type { RunRecord, ScheduleTask } from "../../types.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "../types.ts";
import { captureOutput, formatScheduledPrompt, lastLines, resolveBinary, summarize } from "../run-utils.ts";

/** Names the `claude` executable the adapter spawns, for cron's minimal PATH. */
export const CLAUDE_BIN_ENV = "PI_SCHEDULER_CLAUDE_BIN";

/**
 * Agent adapter for Claude Code: one fresh, headless `claude --print` run per
 * Task Run, asked for a JSON result so the adapter can record the final message
 * and Claude Code's own session id.
 *
 * Like the Pi adapter, it drives the user's installed `claude` CLI rather than
 * an SDK, so credentials, model access, and permissions stay between the user
 * and Claude Code. Claude Code stores its session transcript itself; this
 * adapter writes the JSON result as the run's session record under
 * `.pi/scheduler/sessions/<taskId>/<runId>.json`.
 */
export function createClaudeAdapter(): AgentAdapter {
  return {
    id: "claude",
    displayName: "Claude Code",
    run: runInTaskSession,
  };
}

async function runInTaskSession({
  task,
  run,
  projectDir,
}: AgentRunRequest): Promise<AgentRunResult> {
  const cwd = task.cwd ? resolve(projectDir, task.cwd) : projectDir;
  const sessionFile = claudeSessionFile(projectDir, task.id, run.runId);
  await mkdir(dirname(sessionFile), { recursive: true });

  const bin = resolveClaudeBinary();
  const { code, stdout, stderr } = await captureOutput(bin, claudeArgs(task, run), cwd);
  try {
    const result = parseClaudeResult(stdout, code, stderr);
    await writeSessionFile(sessionFile, result.raw);
    return { sessionFile, summary: summarize(result.text) };
  } catch (error) {
    // A failed run still gets its JSON result recorded, so the run file and
    // session record explain what Claude Code reported.
    if (error instanceof ClaudeRunError) {
      await writeSessionFile(sessionFile, error.result);
      error.message = `${error.message} (result recorded in ${sessionFile})`;
    }
    throw error;
  }
}

async function writeSessionFile(sessionFile: string, raw: Record<string, unknown>): Promise<void> {
  await writeFile(sessionFile, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await chmod(sessionFile, 0o600).catch(() => undefined);
}

/**
 * The argv for one Task Run. `--print` keeps the run non-interactive;
 * `--output-format json` returns the final message plus Claude Code's session
 * id as one JSON object. A task's `tools` become `--allowedTools`, because a
 * headless run cannot approve permission prompts: a tool the task did not
 * allow is denied, not hang. `thinking` has no Claude Code equivalent and is
 * ignored.
 */
export function claudeArgs(task: ScheduleTask, run: RunRecord): string[] {
  return [
    "--print",
    "--output-format",
    "json",
    ...(task.model ? ["--model", task.model] : []),
    ...(task.tools?.length ? ["--allowedTools", task.tools.join(",")] : []),
    formatScheduledPrompt(task, run),
  ];
}

/** The run's session record: Claude Code owns the real transcript; we keep its JSON result. */
export function claudeSessionFile(projectDir: string, taskId: string, runId: string): string {
  return join(schedulerPaths(projectDir).sessionsDir, taskId, `${runId}.json`);
}

/** Finds the `claude` executable: an explicit override first, then $PATH. */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBinary(env, CLAUDE_BIN_ENV, "claude", ["claude.cmd", "claude.exe", "claude"]);
}

type ClaudeResult = { raw: Record<string, unknown>; text: string };

/**
 * Parses `claude --print --output-format json` output. A non-zero exit or an
 * `is_error` result is a failed run; the raw object is kept for the record
 * even when the run failed, so the run file still explains why.
 */
export function parseClaudeResult(stdout: string, code: number | null, stderr: string): ClaudeResult {
  const parsed = parseJson(stdout);
  if (parsed && typeof parsed.result === "string") {
    if (parsed.is_error === true) {
      throw new ClaudeRunError(`claude reported an error: ${lastLines(parsed.result)}`, parsed);
    }
    return { raw: parsed, text: parsed.result };
  }
  throw new Error(`claude exited with ${code}${stderr.trim() ? `: ${lastLines(stderr)}` : ""}`);
}

/** A failed run whose JSON result is still worth keeping in the run record. */
export class ClaudeRunError extends Error {
  constructor(
    message: string,
    readonly result: Record<string, unknown>,
  ) {
    super(message);
  }
}

function parseJson(stdout: string): Record<string, unknown> | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
