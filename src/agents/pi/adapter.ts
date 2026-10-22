import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { schedulerPaths, sessionFileFor } from "../../paths.ts";
import type { RunRecord, ScheduleTask } from "../../types.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "../types.ts";
import { captureOutput, formatScheduledPrompt, lastLines, resolveBinary, summarize } from "../run-utils.ts";
import { LEGACY_TASK_SESSION_ENV, TASK_SESSION_ENV } from "./env.ts";
import { taskSessionFileInPiStore } from "./pi-store.ts";

/** Names the `pi` executable the adapter spawns, for cron's minimal PATH. */
export const PI_BIN_ENV = "AGENTS_CRON_PI_BIN";

/**
 * Set to `1` to store Task Session transcripts in Pi's default session store
 * (`<agentDir>/sessions/--<encoded-cwd>--/`) instead of the scheduler-private
 * layout, so scheduled runs appear in `pi --continue` pickers and pi-web's
 * project session lists like any interactive session. Opt-in and unset by
 * default: existing installs keep the private layout and its behavior.
 */
export const PI_STORE_ENV = "AGENTS_CRON_PI_STORE";

/**
 * Agent adapter for Pi: one fresh, isolated Pi session per Task Run, driven by
 * spawning `pi --print`.
 *
 * The adapter deliberately does not import the Pi SDK. A Task Run has to work
 * from a bare `node` process under cron, where that SDK is not resolvable: it is
 * a peer that Pi provides to its own extension loader, not to standalone CLIs.
 * Spawning `pi` also means a Task Session runs on the user's own Pi — same
 * model, credentials, and project-trust rules — instead of a second copy of the
 * SDK that can drift from it.
 */
export function createPiAdapter(): AgentAdapter {
  return {
    id: "pi",
    displayName: "Pi",
    run: runInTaskSession,
  };
}

async function runInTaskSession({
  task,
  run,
  projectDir,
}: AgentRunRequest): Promise<AgentRunResult> {
  const cwd = task.cwd ? resolve(projectDir, task.cwd) : projectDir;
  const sessionFile = sessionFileForRun(task, projectDir, run.runId);
  await mkdir(dirname(sessionFile), { recursive: true });

  const bin = resolvePiBinary();
  const { code, stdout, stderr } = await captureOutput(
    bin,
    piArgs(task, run, sessionFile),
    cwd,
    { ...process.env, [TASK_SESSION_ENV]: "1", [LEGACY_TASK_SESSION_ENV]: "1" },
  );
  if (code !== 0) {
    throw new Error(`pi exited with ${code}${stderr.trim() ? `: ${lastLines(stderr)}` : ""}`);
  }

  await chmod(sessionFile, 0o600).catch(() => undefined);
  return { sessionFile, summary: summarize(stdout) };
}

/**
 * Where one Task Run's transcript lives. The scheduler-private layout by
 * default; with {@link PI_STORE_ENV} set, Pi's default session store for the
 * directory the run actually works in (task `cwd` override included), so the
 * transcript shows up wherever tools list that project's Pi sessions.
 */
export function sessionFileForRun(
  task: ScheduleTask,
  projectDir: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env[PI_STORE_ENV]?.trim()) {
    const cwd = task.cwd ? resolve(projectDir, task.cwd) : projectDir;
    return taskSessionFileInPiStore(cwd, task.id, runId, env);
  }
  return sessionFileFor(schedulerPaths(projectDir), task.id, runId);
}

/**
 * The argv for one Task Run. `--print` keeps the run non-interactive, which is
 * also what makes the spawned Pi resolve project trust headlessly instead of
 * prompting — the same rule any other non-interactive Pi mode follows.
 */
export function piArgs(task: ScheduleTask, run: RunRecord, sessionFile: string): string[] {
  return [
    "--print",
    "--session",
    sessionFile,
    ...(task.model ? ["--model", task.model] : []),
    ...(task.thinking ? ["--thinking", task.thinking] : []),
    ...(task.tools?.length ? ["--tools", task.tools.join(",")] : []),
    formatScheduledPrompt(task, run),
  ];
}

/** Finds the `pi` executable: an explicit override first, then $PATH. */
export function resolvePiBinary(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBinary(env, PI_BIN_ENV, "pi", ["pi.cmd", "pi.exe", "pi"]);
}
