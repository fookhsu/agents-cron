import type { ScheduleDefinition } from "./scheduling.ts";

/** What caused a Task Run: the planned time arriving, or an explicit request. */
export type Trigger = "scheduled" | "manual";

export type RunStatus = "running" | "success" | "error" | "skipped" | "missed";

export type ScheduleTask = {
  id: string;
  name?: string;
  prompt: string;
  schedule: ScheduleDefinition;
  enabled: boolean;
  nextRunAt?: string;
  /** Agent adapter id; tasks without one run on the default agent. */
  agent?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  tools?: string[];
  /** When this task's runs produce notifications; overrides the project default. */
  notify?: "always" | "error" | "never";
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  runId: string;
  taskId: string;
  trigger: Trigger;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  exitCode?: number;
  /** Agent adapter that drove this run, when one was resolved. */
  agent?: string;
  sessionFile?: string;
  summary?: string;
  error?: string;
};
