import { readFile, rename } from "node:fs/promises";
import { writeJsonAtomic } from "./fs-utils.ts";
import type { ScheduleDefinition } from "./scheduling.ts";
import type { LegacyTask } from "./types.ts";

const STORAGE_VERSION = 1;

type StorageFile = {
  version: number;
  tasks: unknown;
};

export class FileTaskStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  load(): Promise<LegacyTask[]> {
    return loadTasks(this.#filePath);
  }

  save(tasks: LegacyTask[]): Promise<void> {
    return saveTasks(this.#filePath, tasks);
  }
}

export async function loadTasks(filePath: string): Promise<LegacyTask[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let parsed: StorageFile;
  try {
    parsed = JSON.parse(raw) as StorageFile;
  } catch (error) {
    await backupCorruptFile(filePath);
    throw new Error(`Invalid scheduler file ${filePath}: ${(error as Error).message}`);
  }

  if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.tasks)) {
    throw new Error(`Unsupported scheduler file format in ${filePath}`);
  }

  return parsed.tasks.filter(isLegacyTask);
}

export async function saveTasks(filePath: string, tasks: LegacyTask[]): Promise<void> {
  await writeJsonAtomic(filePath, { version: STORAGE_VERSION, tasks });
}

function isLegacyTask(value: unknown): value is LegacyTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<LegacyTask>;
  return (
    typeof task.id === "string" &&
    task.id.length > 0 &&
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
    isScheduleDefinition(task.schedule)
  );
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

async function backupCorruptFile(filePath: string): Promise<void> {
  await rename(filePath, `${filePath}.corrupt.${Date.now()}`).catch(() => undefined);
}

export { STORAGE_VERSION };
