import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Mirrors Pi's default session-store contract so Task Session transcripts can
 * live where every Pi-conformant tool (pi --continue pickers, pi-web, forks)
 * already looks: `<agentDir>/sessions/--<encoded-cwd>--/`.
 *
 * The mirror is deliberate: a Task Run spawns from a bare `node` process
 * under cron, where the Pi SDK is not resolvable, so the path rules are
 * re-stated here instead of imported. They are pinned by unit tests against
 * hand-computed literals from Pi's own implementation
 * (dist/core/session-manager.js `getDefaultSessionDirPath` and
 * dist/config.js `getAgentDir`): a change on either side must turn a test red.
 *
 * Relocations flow through Pi's official environment variables, so a user who
 * moves their store keeps Pi, pi-web, and this scheduler in agreement without
 * any per-tool configuration:
 * - `PI_CODING_AGENT_DIR` — the agent dir (default `~/.pi/agent`); sessions
 *   live under `<dir>/sessions/<encoded-cwd>/`.
 * - `PI_CODING_AGENT_SESSION_DIR` — a flat override: sessions live directly
 *   in this directory with no per-cwd subdirectory.
 */

/** The directory Pi itself uses for sessions created in `cwd`. */
export function piSessionDirFor(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const flat = expandTilde(env.PI_CODING_AGENT_SESSION_DIR);
  if (flat) return resolve(flat);

  const root = expandTilde(env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent");
  return join(root, "sessions", encodeSessionDirName(cwd));
}

/**
 * The transcript for one Task Run inside Pi's store: a first-level `.jsonl`
 * file named after the task and run, because Pi's scanners only collect
 * first-level `.jsonl` files — nesting per task would make transcripts
 * invisible again. The `taskId-` prefix keeps runs attributable to their task
 * when the directory grouping is gone.
 */
export function taskSessionFileInPiStore(
  cwd: string,
  taskId: string,
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(piSessionDirFor(cwd, env), `${taskId}-${runId}.jsonl`);
}

/** Pi's encoding: strip the leading separator, replace `/`, `\`, `:` with `-`. */
function encodeSessionDirName(cwd: string): string {
  return `--${canonicalize(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * The cwd Pi records for a spawned run is `process.cwd()`, which the kernel
 * reports with symlinks resolved — so a task cwd that reaches the project
 * through a symlink must be canonicalized before encoding, or the transcript
 * would land in a directory name no tool ever derives. A missing path falls
 * back to plain resolution, matching what the run is about to create.
 */
function canonicalize(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** Expands a leading `~` the way Pi's `normalizePath` does for env overrides. */
function expandTilde(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}
