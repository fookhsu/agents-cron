import { existsSync, renameSync } from "node:fs";
import { schedulerPaths } from "./paths.ts";
import { updateRegistry } from "./registry.ts";
import { loadTasks } from "./storage.ts";
import type { LegacyTask, ScheduleTask } from "./types.ts";

/**
 * Lazy migration (ADR 0007): the first command that touches a project still
 * carrying a v1 per-project store imports its tasks into the global registry,
 * backfilling `projectDir`, and renames the legacy file aside. Runs, sessions,
 * and notify config are artifacts — they never move. Rollback is renaming the
 * file back and restoring the old crontab lines.
 */

/** Projects whose legacy store has already been handled in this process. */
const imported = new Set<string>();

export async function importLegacyStore(projectDir: string): Promise<void> {
  if (imported.has(projectDir)) return;
  imported.add(projectDir);

  const paths = schedulerPaths(projectDir);
  if (!existsSync(paths.tasksFile)) return;

  const legacy = await loadTasks(paths.tasksFile);
  if (legacy.length === 0) {
    renameAside(paths.tasksFile);
    return;
  }

  await updateRegistry((tasks) => {
    const existing = new Set(tasks.map((task) => task.id));
    const clashes = legacy.filter((task) => existing.has(task.id));
    if (clashes.length > 0) {
      throw new Error(
        `Legacy import aborted: task id(s) already in the registry: ${clashes.map((task) => task.id).join(", ")}`,
      );
    }
    return [...tasks, ...legacy.map((task) => bind(task, projectDir))];
  });

  renameAside(paths.tasksFile);
}

function bind(task: LegacyTask, projectDir: string): ScheduleTask {
  return { ...task, projectDir };
}

function renameAside(tasksFile: string): void {
  renameSync(tasksFile, `${tasksFile}.imported.${Date.now()}`);
}
