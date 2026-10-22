import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./fs-utils.ts";
import type { RunRecord, RunStatus } from "./types.ts";

const RUN_STATUSES: RunStatus[] = ["running", "success", "error", "skipped", "missed"];
const DEFAULT_RUN_TIMEOUT_MINUTES = 30;

export function createTaskId(): string {
  return `task_${randomBytes(4).toString("hex")}`;
}

export function createRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const compact = stamp.replace("T", "").replace("Z", "");
  return `run_${compact}_${randomBytes(4).toString("hex")}`;
}

export async function writeRun(runsDir: string, record: RunRecord): Promise<void> {
  await mkdir(runsDir, { recursive: true });
  await writeJsonAtomic(join(runsDir, `${record.runId}.json`), record);
}

export async function readRun(runsDir: string, runId: string): Promise<RunRecord | undefined> {
  try {
    return parseRun(JSON.parse(await readFile(join(runsDir, `${runId}.json`), "utf8")));
  } catch {
    return undefined;
  }
}

/** All runs, newest first. Malformed files are ignored. */
export async function listRuns(runsDir: string): Promise<RunRecord[]> {
  let files: string[];
  try {
    files = await readdir(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const runs: RunRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const run = await readRun(runsDir, file.slice(0, -".json".length));
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function listRunsForTask(runsDir: string, taskId: string): Promise<RunRecord[]> {
  return (await listRuns(runsDir)).filter((run) => run.taskId === taskId);
}

/**
 * Mark runs stuck in `running` past the timeout as errored so a later invocation
 * can pick the task up again. Returns the reclaimed records.
 */
export async function reclaimStaleRuns(
  runsDir: string,
  now: Date,
  timeoutMinutes = DEFAULT_RUN_TIMEOUT_MINUTES,
): Promise<RunRecord[]> {
  const cutoff = now.getTime() - timeoutMinutes * 60_000;
  const reclaimed: RunRecord[] = [];
  for (const run of await listRuns(runsDir)) {
    if (run.status !== "running") continue;
    const startedAt = new Date(run.startedAt).getTime();
    if (Number.isNaN(startedAt) || startedAt > cutoff) continue;
    const updated: RunRecord = {
      ...run,
      status: "error",
      finishedAt: now.toISOString(),
      exitCode: 1,
      error: `Run timed out after ${timeoutMinutes} minute(s)`,
    };
    await writeRun(runsDir, updated);
    reclaimed.push(updated);
  }
  return reclaimed;
}

/**
 * Keep the newest `keep` runs per task; delete the rest, together with their
 * report files when a reports dir is given. Returns the deleted run count.
 */
export async function pruneRuns(runsDir: string, reportsDir: string | undefined, keep: number): Promise<number> {
  if (keep < 0) throw new Error("keep must not be negative");
  const byTask = new Map<string, RunRecord[]>();
  for (const run of await listRuns(runsDir)) {
    const list = byTask.get(run.taskId) ?? [];
    list.push(run);
    byTask.set(run.taskId, list);
  }

  let deleted = 0;
  for (const runs of byTask.values()) {
    for (const run of runs.slice(keep)) {
      await unlink(join(runsDir, `${run.runId}.json`)).catch(() => undefined);
      if (reportsDir) {
        await unlink(join(reportsDir, run.taskId, `${run.runId}.md`)).catch(() => undefined);
      }
      deleted += 1;
    }
  }
  return deleted;
}

function parseRun(value: unknown): RunRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const run = value as Partial<RunRecord>;
  if (
    typeof run.runId !== "string" ||
    typeof run.taskId !== "string" ||
    (run.trigger !== "scheduled" && run.trigger !== "manual") ||
    typeof run.startedAt !== "string" ||
    typeof run.status !== "string" ||
    !RUN_STATUSES.includes(run.status as RunStatus)
  ) {
    return undefined;
  }
  return run as RunRecord;
}
