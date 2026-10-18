import { schedulerPaths } from "./paths.ts";
import { createTaskId } from "./runs.ts";
import { calculateNextRun, parseScheduleInput, type ScheduleInput } from "./scheduling.ts";
import { loadTasks, saveTasks } from "./storage.ts";
import { TaskNotFoundError } from "./runner.ts";
import type { ScheduleTask } from "./types.ts";

export type NewTaskInput = {
  prompt: string;
  schedule: ScheduleInput;
  name?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  tools?: string[];
  notify?: "always" | "error" | "never";
};

export async function listTasks(projectDir: string): Promise<ScheduleTask[]> {
  const tasks = await loadTasks(schedulerPaths(projectDir).tasksFile);
  return tasks.sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
}

export async function addTask(
  projectDir: string,
  input: NewTaskInput,
  now = new Date(),
): Promise<ScheduleTask> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Task prompt must not be empty");

  const tasks = await loadTasks(schedulerPaths(projectDir).tasksFile);
  const schedule = parseScheduleInput(input.schedule);
  const task: ScheduleTask = {
    id: createTaskId(),
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    prompt,
    schedule,
    enabled: true,
    nextRunAt: initialNextRun(schedule, now),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinking ? { thinking: input.thinking } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.notify ? { notify: input.notify } : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  tasks.push(task);
  await saveTasks(schedulerPaths(projectDir).tasksFile, tasks);
  return task;
}

export async function setTaskEnabled(
  projectDir: string,
  id: string,
  enabled: boolean,
): Promise<ScheduleTask> {
  const tasks = await loadTasks(schedulerPaths(projectDir).tasksFile);
  const task = requireTask(tasks, id);
  task.enabled = enabled;
  task.updatedAt = new Date().toISOString();
  await saveTasks(schedulerPaths(projectDir).tasksFile, tasks);
  return task;
}

export async function removeTask(projectDir: string, id: string): Promise<void> {
  const tasks = await loadTasks(schedulerPaths(projectDir).tasksFile);
  const task = requireTask(tasks, id);
  await saveTasks(
    schedulerPaths(projectDir).tasksFile,
    tasks.filter((entry) => entry.id !== task.id),
  );
}

export async function clearTasks(projectDir: string): Promise<number> {
  const tasks = await loadTasks(schedulerPaths(projectDir).tasksFile);
  await saveTasks(schedulerPaths(projectDir).tasksFile, []);
  return tasks.length;
}

export function requireTask(tasks: ScheduleTask[], id: string): ScheduleTask {
  const exact = tasks.find((task) => task.id === id);
  if (exact) return exact;
  const matches = tasks.filter((task) => task.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new TaskNotFoundError(`Task ID is ambiguous: ${id}`);
  throw new TaskNotFoundError(`Task not found: ${id}`);
}

function initialNextRun(schedule: ScheduleTask["schedule"], now: Date): string | undefined {
  if (schedule.kind === "once") return schedule.runAt;
  return calculateNextRun(schedule, now)?.toISOString();
}
