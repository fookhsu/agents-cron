import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { RunRecord, ScheduleTask } from "../types.ts";

/**
 * Shared plumbing for adapters that drive an agent by spawning its CLI. The
 * Pi and Claude Code adapters both build on these; nothing here knows a
 * specific agent.
 */

/** The prompt handed to an agent for one Task Run: run metadata, then the task's prompt. */
export function formatScheduledPrompt(task: ScheduleTask, run: RunRecord): string {
  return [
    "[Scheduled task]",
    `Task ID: ${task.id}`,
    `Task name: ${task.name ?? "(unnamed)"}`,
    `Run ID: ${run.runId}`,
    "",
    task.prompt,
  ].join("\n");
}

export type ProcessResult = { code: number | null; stdout: string; stderr: string };

/** Runs a binary to completion with no stdin, capturing stdout and stderr. */
export function captureOutput(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise((settle, fail) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => fail(new Error(`Could not run ${bin}: ${error.message}`)));
    child.on("close", (code) => settle({ code, stdout, stderr }));
  });
}

/**
 * Finds an agent executable: an explicit override env var first, then $PATH.
 * Cron starts jobs with a minimal PATH, so adapters must resolve their binary
 * themselves and name the override variable in the error. The pre-rename
 * `PI_SCHEDULER_*` spelling of the override is still honored, so crontabs
 * written before the rename keep working.
 */
export function resolveBinary(
  env: NodeJS.ProcessEnv,
  overrideEnvVar: string,
  unixName: string,
  windowsNames: string[],
): string {
  const legacyEnvVar = overrideEnvVar.replace(/^AGENTS_CRON_/, "PI_SCHEDULER_");
  const override = (env[overrideEnvVar] ?? env[legacyEnvVar])?.trim();
  if (override) return override;

  const windows = process.platform === "win32";
  const names = windows ? windowsNames : [unixName];
  const mode = windows ? constants.F_OK : constants.X_OK;

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, mode);
        return candidate;
      } catch {
        // Not in this directory; keep looking.
      }
    }
  }

  throw new Error(
    `Could not find "${unixName}" on PATH, which is expected under cron. Set ${overrideEnvVar} to the full path of the ${unixName} executable.`,
  );
}

/** Trims an agent's final message to a run-summary length. */
export function summarize(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 1_000 ? `${trimmed.slice(0, 1_000)}…` : trimmed;
}

/** The last few non-empty lines of an error stream, joined for an error message. */
export function lastLines(text: string, count = 3): string {
  return text.trim().split("\n").filter(Boolean).slice(-count).join(" / ");
}
