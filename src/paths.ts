import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The store lives under `.agents/`, the cross-tool convention directory that
 * agent CLIs (and Pi) already use for shared, agent-specific state. We claim
 * exactly one namespaced subdirectory — `cron/` — and leave the conventional
 * entries (`.agents/skills/`, `.agents/agents/`, `.agents/tasks/`, …) to the
 * tools that own them.
 */
const AGENTS_DIR = ".agents";
const STORE_NAME = "cron";

/** The store location before 0.7.0, kept only for one-time migration. */
const LEGACY_STORE = join(".pi", "scheduler");

export type SchedulerPaths = {
  dir: string;
  tasksFile: string;
  lockFile: string;
  runsDir: string;
  reportsDir: string;
  sessionsDir: string;
};

/** Projects whose legacy store has already been handled in this process. */
const migrated = new Set<string>();

/**
 * One-time carry-over from the pre-0.7 store `.pi/scheduler/` to
 * `.agents/cron/`, before the first store access. Copies instead of moving,
 * so a crontab entry still redirecting output to `.pi/scheduler/cron.log`
 * keeps working until it is updated; the old copy is then safe to delete.
 * The transient run.lock is deliberately not carried over — a copied lock
 * would look like another instance holds it. Runs at most once per project
 * per process, and only when the new store does not already exist.
 */
function migrateLegacyStore(projectDir: string): void {
  if (migrated.has(projectDir)) return;
  migrated.add(projectDir);

  const legacy = join(projectDir, LEGACY_STORE);
  const store = join(projectDir, AGENTS_DIR, STORE_NAME);
  try {
    if (!existsSync(join(legacy, "tasks.json"))) return;
    if (existsSync(join(store, "tasks.json"))) return;

    cpSync(legacy, store, { recursive: true });
    rmSync(join(store, "run.lock"), { force: true });
    process.stderr.write(
      `[agents-cron] store moved to ${store} (copied from ${legacy}; delete the old copy when convenient)\n`,
    );
  } catch (err) {
    // Migration is best-effort: a failure leaves the (possibly empty) new
    // store in place rather than breaking the command that triggered it.
    process.stderr.write(`[agents-cron] could not migrate ${legacy}: ${err}\n`);
  }
}

/** Project-local scheduler storage layout: <project>/.agents/cron/... */
export function schedulerPaths(projectDir: string): SchedulerPaths {
  migrateLegacyStore(projectDir);
  const dir = join(projectDir, AGENTS_DIR, STORE_NAME);
  return {
    dir,
    tasksFile: join(dir, "tasks.json"),
    lockFile: join(dir, "run.lock"),
    runsDir: join(dir, "runs"),
    reportsDir: join(dir, "reports"),
    sessionsDir: join(dir, "sessions"),
  };
}

export type RegistryPaths = {
  dir: string;
  tasksFile: string;
  /** Extension bookkeeping (the update-notice marker), not task data. */
  stateFile: string;
  /** The Registry Lock: serializes read-modify-write of the registry, never held during execution. */
  lockFile: string;
};

/**
 * The Task Registry (ADR 0007): machine-wide, under
 * `$AGENTS_CRON_HOME ?? $HOME` + `.agents/cron/`. The env override exists for
 * test injection and non-default homes; it never relocates project stores.
 */
export function registryPaths(): RegistryPaths {
  const root = process.env.AGENTS_CRON_HOME ?? homedir();
  const dir = join(root, AGENTS_DIR, STORE_NAME);
  return {
    dir,
    tasksFile: join(dir, "tasks.json"),
    stateFile: join(dir, "extension-state.json"),
    lockFile: join(dir, "registry.lock"),
  };
}

/** Session file for one task run: sessions/<taskId>/<runId>.jsonl */
export function sessionFileFor(paths: SchedulerPaths, taskId: string, runId: string): string {
  return join(paths.sessionsDir, taskId, `${runId}.jsonl`);
}
