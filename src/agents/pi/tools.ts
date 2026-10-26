import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { schedulerPaths } from "../../paths.ts";
import { listRunsForTask } from "../../runs.ts";
import { runTask } from "../../runner.ts";
import type { ScheduleInput } from "../../scheduling.ts";
import { addTask, clearTasks, listTasks, removeTask, requireTask, setTaskEnabled } from "../../task-service.ts";
import type { RunRecord, ScheduleTask } from "../../types.ts";
import { confirmMutation } from "./confirm.ts";

const actionSchema = StringEnum([
  "add",
  "list",
  "show",
  "enable",
  "disable",
  "delete",
  "run",
  "runs",
  "clear",
] as const);

const scheduleSchema = Type.Object({
  kind: StringEnum(["once", "interval", "cron"] as const),
  runAt: Type.Optional(Type.String()),
  every: Type.Optional(Type.String()),
  expression: Type.Optional(
    Type.String({
      description:
        "Cron expression: 5 or 6 fields, or a nickname such as @daily, @hourly, @weekly, @monthly, @yearly, @annually.",
    }),
  ),
  timezone: Type.Optional(Type.String()),
});

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "schedule_task",
    label: "Schedule Task",
    description: "Create, inspect, enable, disable, run, or delete scheduled prompt tasks for this Pi project.",
    // Deferred: not declared to the model until tool_search loads it, so the
    // resident manifest stays slim; see ensureToolSearchActive().
    exposure: "deferred",
    promptSnippet: "Manage scheduled prompt tasks",
    promptGuidelines: [
      "Use schedule_task when the user asks Pi to perform a task later or repeatedly.",
      "Scheduled tasks are project-scoped and run in isolated Task Sessions, not in the user's session.",
      "Do not create duplicate tasks when an existing task already represents the same request.",
      "Only create a task once the user has expressed its timing (a date/time, an interval, or a cron expression); if the timing is missing or ambiguous, ask the user to clarify — never guess a schedule.",
      "After creating a task, repeat its id and next run time back to the user so they can verify or undo it.",
    ],
    parameters: Type.Object({
      action: actionSchema,
      id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      agent: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      tools: Type.Optional(Type.Array(Type.String())),
      schedule: Type.Optional(scheduleSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "add") {
        if (!params.prompt || !params.schedule) throw new Error("add requires prompt and schedule");
        const task = await addTask(ctx.cwd, {
          name: params.name,
          prompt: params.prompt,
          schedule: toScheduleInput(params.schedule),
          agent: params.agent,
          model: params.model,
          thinking: params.thinking,
          cwd: params.cwd,
          tools: params.tools,
        });
        return result(`Created ${task.id}; next run ${task.nextRunAt ?? "never"}`, task);
      }

      if (params.action === "list") {
        const tasks = await listTasks(ctx.cwd);
        return result(tasks.length ? tasks.map(formatTask).join("\n") : "No scheduled tasks.", { tasks });
      }

      if (!params.id && params.action !== "clear") throw new Error(`${params.action} requires id`);

      if (params.action === "show") {
        const task = requireTask(await listTasks(ctx.cwd), params.id!);
        return result(`${formatTask(task)}\nprompt:\n${task.prompt}`, task);
      }

      if (params.action === "runs") {
        const runs = await listRunsForTask(schedulerPaths(ctx.cwd).runsDir, params.id!);
        return result(runs.length ? runs.map(formatRun).join("\n") : `No runs for ${params.id}.`, { runs });
      }
      if (params.action === "enable") {
        return result(`Enabled ${params.id}`, await setTaskEnabled(ctx.cwd, params.id!, true));
      }
      if (params.action === "disable") {
        return result(`Disabled ${params.id}`, await setTaskEnabled(ctx.cwd, params.id!, false));
      }
      if (params.action === "run") {
        const outcome = await runTask(ctx.cwd, params.id!, {});
        return result(`${outcome.status}: ${outcome.taskId} (${outcome.runId || "not started"})`);
      }
      if (params.action === "delete") {
        await confirmMutation(ctx, `Delete scheduled task ${params.id}?`);
        await removeTask(ctx.cwd, params.id!);
        return result(`Deleted ${params.id}`);
      }
      if (params.action === "clear") {
        await confirmMutation(ctx, "Delete all scheduled tasks?");
        return result(`Cleared ${await clearTasks(ctx.cwd)} task(s)`);
      }

      throw new Error(`Unsupported action: ${params.action}`);
    },
  });
}

function toScheduleInput(schedule: {
  kind: "once" | "interval" | "cron";
  runAt?: string;
  every?: string;
  expression?: string;
  timezone?: string;
}): ScheduleInput {
  if (schedule.kind === "once") {
    if (!schedule.runAt) throw new Error("once schedule requires runAt");
    return { kind: "once", runAt: schedule.runAt };
  }
  if (schedule.kind === "interval") {
    if (!schedule.every) throw new Error("interval schedule requires every");
    return { kind: "interval", every: schedule.every };
  }
  if (!schedule.expression) throw new Error("cron schedule requires expression");
  return { kind: "cron", expression: schedule.expression, timezone: schedule.timezone };
}

function result(text: string, details: unknown = {}): {
  content: [{ type: "text"; text: string }];
  details: unknown;
} {
  return { content: [{ type: "text", text }], details };
}

function formatTask(task: ScheduleTask): string {
  return `${task.id} [${task.enabled ? "enabled" : "disabled"}] ${task.name ?? "-"} — ${formatSchedule(task)} — next ${task.nextRunAt ?? "never"}`;
}

function formatRun(run: RunRecord): string {
  return `${run.runId} [${run.status}] ${run.trigger} — ${run.finishedAt ?? run.startedAt}`;
}

function formatSchedule(task: ScheduleTask): string {
  if (task.schedule.kind === "interval") return `every ${task.schedule.everyMs}ms`;
  if (task.schedule.kind === "cron") return `cron ${task.schedule.expression}`;
  return `once ${task.schedule.runAt}`;
}
