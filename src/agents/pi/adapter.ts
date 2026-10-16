import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { sessionFileFor, schedulerPaths } from "../../paths.ts";
import type { RunRecord, ScheduleTask } from "../../types.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "../types.ts";
import { captureOutput, formatScheduledPrompt, lastLines, resolveBinary, summarize } from "../run-utils.ts";
import { TASK_SESSION_ENV } from "./env.ts";

/** Names the `pi` executable the adapter spawns, for cron's minimal PATH. */
export const PI_BIN_ENV = "PI_SCHEDULER_PI_BIN";

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
  const sessionFile = sessionFileFor(schedulerPaths(projectDir), task.id, run.runId);
  await mkdir(dirname(sessionFile), { recursive: true });

  const bin = resolvePiBinary();
  const { code, stdout, stderr } = await captureOutput(
    bin,
    piArgs(task, run, sessionFile),
    cwd,
    { ...process.env, [TASK_SESSION_ENV]: "1" },
  );
  if (code !== 0) {
    throw new Error(`pi exited with ${code}${stderr.trim() ? `: ${lastLines(stderr)}` : ""}`);
  }

  await chmod(sessionFile, 0o600).catch(() => undefined);
  return { sessionFile, summary: summarize(stdout) };
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
