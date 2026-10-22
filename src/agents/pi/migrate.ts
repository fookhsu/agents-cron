import { chmod, copyFile, mkdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { schedulerPaths, type SchedulerPaths } from "../../paths.ts";
import { loadRegistry } from "../../registry.ts";
import { importLegacyStore } from "../../migration.ts";
import { listRuns, writeRun } from "../../runs.ts";
import type { RunRecord } from "../../types.ts";
import { taskSessionFileInPiStore } from "./pi-store.ts";

/** One legacy transcript carried into Pi's default session store. */
export type MigrationMove = { runId: string; from: string; to: string };

/** A record rewritten to point at a transcript already in the store. */
export type MigrationRelink = { runId: string; to: string };

/** A run left as-is, with the reason. */
export type MigrationSkip = { runId: string; reason: string };

export type MigrationReport = {
  moves: MigrationMove[];
  relinks: MigrationRelink[];
  skips: MigrationSkip[];
};

/**
 * Carries legacy private-layout Task Session transcripts
 * (`.agents/cron/sessions/<taskId>/<runId>.jsonl`) into Pi's default session
 * store, where standard Pi tooling lists them, and rewrites each run record's
 * `sessionFile` to the new location. Idempotent: a second pass skips runs
 * whose records already point into the store, and never clobbers a file that
 * already exists at the target.
 *
 * The store directory for each transcript is derived from the cwd the run
 * actually worked in — read from the session header the spawned `pi` wrote —
 * falling back to the task's current `cwd` and then the project root. Only pi
 * runs move: other agents' transcripts are not Pi sessions.
 */
export async function migratePiSessions(options: {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
}): Promise<MigrationReport> {
  const projectDir = options.projectDir;
  const paths = schedulerPaths(projectDir);
  const env = options.env ?? process.env;
  // Only this project's own tasks may answer the cwd fallback: ids are unique
  // per registry, but the registry spans every project, and a same-id task
  // bound elsewhere (or a stale local id) must not relocate this project's
  // transcripts.
  const local = resolve(projectDir);
  // Bring a pre-registry project's tasks.json in first, exactly like any
  // other read path, so the cwd fallback sees tasks that were never listed
  // since the 0.9 registry migration.
  await importLegacyStore(projectDir);
  const tasks = new Map(
    (await loadRegistry())
      .filter((task) => resolve(task.projectDir) === local)
      .map((task) => [task.id, task]),
  );

  const report: MigrationReport = { moves: [], relinks: [], skips: [] };
  const touchedTaskDirs = new Set<string>();

  for (const run of await listRuns(paths.runsDir)) {
    if (run.agent && run.agent !== "pi") {
      report.skips.push({ runId: run.runId, reason: `agent ${run.agent}` });
      continue;
    }

    const legacy = join(paths.sessionsDir, run.taskId, `${run.runId}.jsonl`);
    const target = taskSessionFileInPiStore(await cwdForRun(run, legacy, tasks.get(run.taskId), projectDir), run.taskId, run.runId, env);
    const legacyExists = await canStat(legacy);
    const targetExists = await canStat(target);

    if (legacyExists && targetExists) {
      report.skips.push({ runId: run.runId, reason: "target already exists" });
      continue;
    }
    if (legacyExists) {
      report.moves.push({ runId: run.runId, from: legacy, to: target });
      touchedTaskDirs.add(join(paths.sessionsDir, run.taskId));
      if (options.dryRun) continue;
      await moveTranscript(legacy, target);
      await writeRun(paths.runsDir, { ...run, sessionFile: target });
      continue;
    }
    if (targetExists) {
      if (run.sessionFile === target) {
        report.skips.push({ runId: run.runId, reason: "already migrated" });
      } else {
        report.relinks.push({ runId: run.runId, to: target });
        if (options.dryRun) continue;
        await writeRun(paths.runsDir, { ...run, sessionFile: target });
      }
      continue;
    }
    report.skips.push({ runId: run.runId, reason: "no transcript" });
  }

  if (!options.dryRun) await removeEmptyLegacyDirs(paths, touchedTaskDirs);
  return report;
}

/**
 * The cwd a run actually worked in. The session header records what the
 * spawned `pi` saw as `process.cwd()`, so it wins; a task whose `cwd` changed
 * since the run (or was removed) still lands in the right project's store.
 */
async function cwdForRun(
  run: RunRecord,
  legacy: string,
  task: { cwd?: string } | undefined,
  projectDir: string,
): Promise<string> {
  try {
    const firstLine = (await readFile(legacy, "utf8")).split("\n", 1)[0];
    const header = JSON.parse(firstLine) as { type?: string; cwd?: string };
    if (header.type === "session" && typeof header.cwd === "string" && header.cwd) {
      return resolve(header.cwd);
    }
  } catch {
    // No readable header (missing file, empty or malformed transcript):
    // fall through to the task definition.
  }
  if (task?.cwd) return resolve(projectDir, task.cwd);
  return projectDir;
}

/** Moves a transcript, preserving 0600 across filesystems. */
async function moveTranscript(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await chmod(to, 0o600).catch(() => undefined);
    await rm(from, { force: true });
  }
}

/** Best-effort cleanup of task directories left empty by the moves. */
async function removeEmptyLegacyDirs(paths: SchedulerPaths, taskDirs: Set<string>): Promise<void> {
  // rmdir removes only empty directories, so a task with unmigrated files
  // (foreign agents, conflicts) keeps its directory.
  for (const dir of taskDirs) await rmdir(dir).catch(() => undefined);
  await rmdir(paths.sessionsDir).catch(() => undefined);
}

async function canStat(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
