import { readFile, rename } from "node:fs/promises";
import { writeJsonAtomic } from "./fs-utils.ts";
import { acquireLock } from "./lock.ts";
import { registryPaths, type RegistryPaths } from "./paths.ts";
import type { ScheduleDefinition } from "./scheduling.ts";
import type { RunStatus, ScheduleTask } from "./types.ts";

/**
 * The Task Registry (ADR 0007): one machine-wide, version-2 store at
 * `~/.agents/cron/tasks.json`. Unlike the legacy per-project store, malformed
 * entries throw instead of being filtered away — the registry is the single
 * source of truth, and silently dropping a task from it would lose the task.
 */

const REGISTRY_VERSION = 2;

type RegistryFile = {
  version: number;
  tasks: unknown;
};

export async function loadRegistry(paths: RegistryPaths = registryPaths()): Promise<ScheduleTask[]> {
  let raw: string;
  try {
    raw = await readFile(paths.tasksFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let parsed: RegistryFile;
  try {
    parsed = JSON.parse(raw) as RegistryFile;
  } catch (error) {
    await backupCorruptFile(paths.tasksFile);
    throw new Error(`Invalid task registry ${paths.tasksFile}: ${(error as Error).message}`);
  }

  if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.tasks)) {
    throw new Error(`Unsupported task registry format in ${paths.tasksFile}`);
  }

  const tasks = parsed.tasks as unknown[];
  for (const entry of tasks) {
    if (!isRegistryTask(entry)) {
      throw new Error(`Malformed task in registry ${paths.tasksFile}: ${JSON.stringify(entry)}`);
    }
  }
  return tasks as ScheduleTask[];
}

export async function saveRegistry(
  tasks: ScheduleTask[],
  paths: RegistryPaths = registryPaths(),
): Promise<void> {
  for (const task of tasks) {
    if (!isRegistryTask(task)) {
      throw new Error(`Refusing to save malformed task: ${JSON.stringify(task)}`);
    }
  }
  await writeJsonAtomic(paths.tasksFile, { version: REGISTRY_VERSION, tasks });
}

const LOCK_RETRY_BUDGET_MS = 5_000;
const LOCK_RETRY_DELAY_MS = 25;

/**
 * A locked read-modify-write over the registry: fn receives the current
 * tasks and returns the updated list; the Registry Lock is held for the
 * whole cycle and never during task execution. Contending writers retry
 * briefly — the lock is short-lived by construction — then fail loudly.
 */
export async function updateRegistry(
  mutate: (tasks: ScheduleTask[]) => ScheduleTask[] | Promise<ScheduleTask[]>,
  paths: RegistryPaths = registryPaths(),
): Promise<ScheduleTask[]> {
  const deadline = Date.now() + LOCK_RETRY_BUDGET_MS;
  for (;;) {
    const lock = await acquireLock(paths.lockFile);
    if (lock) {
      try {
        const tasks = await mutate(await loadRegistry(paths));
        await saveRegistry(tasks, paths);
        return tasks;
      } finally {
        await lock.release();
      }
    }
    if (Date.now() >= deadline) throw new Error(`Task registry lock busy: ${paths.lockFile}`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
}

function isRegistryTask(value: unknown): value is ScheduleTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<ScheduleTask>;
  return (
    typeof task.id === "string" &&
    task.id.length > 0 &&
    typeof task.projectDir === "string" &&
    task.projectDir.length > 0 &&
    typeof task.prompt === "string" &&
    task.prompt.length > 0 &&
    typeof task.enabled === "boolean" &&
    typeof task.createdAt === "string" &&
    typeof task.updatedAt === "string" &&
    (task.nextRunAt === undefined || typeof task.nextRunAt === "string") &&
    (task.name === undefined || typeof task.name === "string") &&
    (task.agent === undefined || typeof task.agent === "string") &&
    (task.model === undefined || typeof task.model === "string") &&
    (task.thinking === undefined || typeof task.thinking === "string") &&
    (task.cwd === undefined || typeof task.cwd === "string") &&
    (task.tools === undefined ||
      (Array.isArray(task.tools) && task.tools.every((tool) => typeof tool === "string"))) &&
    (task.notify === undefined ||
      task.notify === "always" ||
      task.notify === "error" ||
      task.notify === "never") &&
    (task.lastRunAt === undefined || typeof task.lastRunAt === "string") &&
    (task.lastStatus === undefined || isRunStatus(task.lastStatus)) &&
    isNonNegativeCount(task.successCount) &&
    isNonNegativeCount(task.errorCount) &&
    isNonNegativeCount(task.missedCount) &&
    isScheduleDefinition(task.schedule)
  );
}

/** Moves an unparseable registry aside so the next save starts from scratch, not from poison. */
async function backupCorruptFile(tasksFile: string): Promise<void> {
  await rename(tasksFile, `${tasksFile}.corrupt.${Date.now()}`).catch(() => undefined);
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "running" ||
    value === "success" ||
    value === "error" ||
    value === "skipped" ||
    value === "missed"
  );
}

function isNonNegativeCount(value: number | undefined): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  if (!value || typeof value !== "object") return false;
  const schedule = value as Partial<ScheduleDefinition>;
  if (schedule.kind === "once") return typeof schedule.runAt === "string";
  if (schedule.kind === "interval") {
    return typeof schedule.everyMs === "number" && schedule.everyMs > 0;
  }
  if (schedule.kind === "cron") return typeof schedule.expression === "string";
  return false;
}
