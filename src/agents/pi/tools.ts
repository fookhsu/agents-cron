import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatRunLine, formatTaskDetail, formatTaskLine, stamp } from "../../format.ts";
import { schedulerPaths } from "../../paths.ts";
import { listRunsForTask } from "../../runs.ts";
import { runTask } from "../../runner.ts";
import type { ScheduleInput } from "../../scheduling.ts";
import { addTask, clearTasks, describeOverrides, listTasks, removeTask, requireTask, setTaskEnabled, updateTask, type TaskPatch } from "../../task-service.ts";
import { confirmMutation } from "./confirm.ts";

const actionSchema = StringEnum([
  "add",
  "update",
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
      "When the user wants a task on a specific model or thinking level, pass model and thinking (update changes them later on an existing task); thinking accepts off, minimal, low, medium, high, xhigh, max.",
      "When the user wants to perceive a task's output, resolve its notification before creating it: route only to channel ids that exist in the project's .agents/cron/config.json, and set the level with notify.",
      "After creating a task, repeat its id and next run time back to the user so they can verify or undo it.",
    ],
    parameters: Type.Object({
      action: actionSchema,
      id: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      agent: Type.Optional(
        Type.String({ description: "Agent adapter id: pi, claude, or codex. In update, an empty string clears the override." }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model id for this task's runs, e.g. anthropic/claude-opus-4-5 or the :level shorthand sonnet:high. In update, an empty string clears the override.",
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description:
            "Thinking level for the pi agent: off, minimal, low, medium, high, xhigh, max. Ignored by claude and codex. In update, an empty string clears the override.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory for the run, relative to the project. In update, an empty string clears the override." }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Tool allowlist. In update, an empty array clears the override so runs use the agent's default tool set.",
        }),
      ),
      notify: Type.Optional(
        Type.Union([
          StringEnum(["always", "error", "never"] as const, { description: "When this task's runs produce notifications; overrides the project default." }),
          Type.Literal("", { description: "In update: clear the notify override." }),
        ]),
      ),
      notifyTo: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Channel ids from .agents/cron/config.json to route this task's notifications to; omit to notify every configured channel. In update, an empty array clears the routing.",
        }),
      ),
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
          ...(params.notify ? { notify: params.notify } : {}),
          ...(params.notifyTo?.length ? { notifyTo: params.notifyTo } : {}),
        });
        return result(`Created ${task.id}; next run ${stamp(task.nextRunAt)}`, task);
      }

      if (params.action === "list") {
        const tasks = await listTasks(ctx.cwd);
        return result(tasks.length ? tasks.map((task) => formatTaskLine(task)).join("\n") : "No scheduled tasks.", { tasks });
      }

      if (params.action === "update") {
        if (!params.id) throw new Error("update requires id");
        const patch: TaskPatch = {};
        if (params.name !== undefined) patch.name = params.name;
        if (params.agent !== undefined) patch.agent = params.agent;
        if (params.model !== undefined) patch.model = params.model;
        if (params.thinking !== undefined) patch.thinking = params.thinking;
        if (params.cwd !== undefined) patch.cwd = params.cwd;
        if (params.tools !== undefined) patch.tools = params.tools;
        if (params.notify !== undefined) patch.notify = params.notify;
        if (params.notifyTo !== undefined) patch.notifyTo = params.notifyTo;
        const task = await updateTask(ctx.cwd, params.id, patch);
        const overrides = describeOverrides(task);
        return result(
          `Updated ${task.id}${overrides.length ? ` — ${overrides.join("; ")}` : " — no overrides; runs use the project and user defaults"}`,
          task,
        );
      }

      if (!params.id && params.action !== "clear") throw new Error(`${params.action} requires id`);

      if (params.action === "show") {
        const task = requireTask(await listTasks(ctx.cwd), params.id!);
        return result(formatTaskDetail(task), task);
      }

      if (params.action === "runs") {
        const runs = await listRunsForTask(schedulerPaths(ctx.cwd).runsDir, params.id!);
        return result(runs.length ? runs.map((run) => formatRunLine(run, { session: true })).join("\n") : `No runs for ${params.id}.`, { runs });
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
