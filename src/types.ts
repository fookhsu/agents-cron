import type { ScheduleDefinition } from "./scheduling.ts";

/** What caused a Task Run: the planned time arriving, or an explicit request. */
export type Trigger = "scheduled" | "manual";

export type RunStatus = "running" | "success" | "error" | "skipped" | "missed";

export type ScheduleTask = {
  id: string;
  /** The belongs-to binding: artifacts, run lock, and notify config all follow it. */
  projectDir: string;  name?: string;
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
  /** Channel ids this task's runs notify; absent or empty means every configured channel. */
  notifyTo?: string[];
  /** Registry state: the most recent run of any trigger. */
  lastRunAt?: string;
  lastStatus?: RunStatus;
  /** Registry state: lifetime run counters, manual runs included. */
  successCount?: number;
  errorCount?: number;
  missedCount?: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * A task as stored by the pre-ADR-0007 per-project store (version 1): a
 * ScheduleTask without the `projectDir` binding, which only the global
 * registry requires. Read-only today — import-only, via `importLegacyStore`.
 */
export type LegacyTask = Omit<ScheduleTask, "projectDir">;

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
