import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readRun, listRunsForTask } from "../../runs.ts";
import { runTask } from "../../runner.ts";
import { schedulerPaths } from "../../paths.ts";
import { parseDuration, parseScheduleSpec } from "../../scheduling.ts";
import { addTask, clearTasks, listTasks, removeTask, setTaskEnabled } from "../../task-service.ts";
import type { RunRecord, ScheduleTask } from "../../types.ts";
import { confirmMutation } from "./confirm.ts";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("loop", {
    description: 'Create a recurring task: /loop 30m check CI, or /loop "*/5 * * * *" check CI',
    handler: async (args, ctx) => {
      await guard(ctx, async () => {
        const match = /^\s*("[^"]*"|\S+)\s+([\s\S]+?)\s*$/.exec(args);
        if (!match) throw new Error("Usage: /loop <duration|cron> <prompt>");
        const task = await addTask(ctx.cwd, {
          prompt: match[2],
          schedule: parseScheduleSpec(match[1]),
        });
        ctx.ui.notify(`Created ${task.id}; next run ${formatDate(task.nextRunAt)}`, "info");
      });
    },
  });

  pi.registerCommand("remind", {
    description: "Create a one-time task: /remind in 45m check the PR",
    handler: async (args, ctx) => {
      await guard(ctx, async () => {
        const parsed = parseReminder(args);
        const task = await addTask(ctx.cwd, {
          prompt: parsed.prompt,
          schedule: { kind: "once", runAt: parsed.runAt },
        });
        ctx.ui.notify(`Created ${task.id}; scheduled for ${formatDate(task.nextRunAt)}`, "info");
      });
    },
  });

  pi.registerCommand("schedule", {
    description: "List and manage scheduled tasks",
    handler: async (args, ctx) => {
      await guard(ctx, async () => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const action = tokens[0] ?? "list";
        const paths = schedulerPaths(ctx.cwd);

        if (action === "list") {
          const tasks = await listTasks(ctx.cwd);
          ctx.ui.notify(tasks.length ? tasks.map(formatTask).join("\n") : "No scheduled tasks.", "info");
          return;
        }
        if (action === "add") {
          const match = /^\s*add\s+("[^"]*"|\S+)\s+([\s\S]+?)\s*$/.exec(args);
          if (!match) throw new Error("Usage: /schedule add <duration|cron> <prompt>");
          const task = await addTask(ctx.cwd, { prompt: match[2], schedule: parseScheduleSpec(match[1]) });
          ctx.ui.notify(`Created ${task.id}; next run ${formatDate(task.nextRunAt)}`, "info");
          return;
        }
        if (action === "runs") {
          const id = requireId(tokens[1], "runs");
          const runs = await listRunsForTask(paths.runsDir, id);
          ctx.ui.notify(runs.length ? runs.map(formatRun).join("\n") : `No runs for ${id}.`, "info");
          return;
        }
        if (action === "open") {
          const runId = requireId(tokens[1], "open");
          const run = await readRun(paths.runsDir, runId);
          if (!run) throw new Error(`Run not found: ${runId}`);
          if (!run.sessionFile) throw new Error(`Run ${runId} has no session file`);
          ctx.ui.notify(`Task Session: ${run.sessionFile}\nOpen it with: pi --session ${run.sessionFile}`, "info");
          return;
        }

        if (action === "clear") {
          await confirmMutation(ctx, "Delete all scheduled tasks?");
          ctx.ui.notify(`Cleared ${await clearTasks(ctx.cwd)} task(s)`, "info");
          return;
        }

        const id = requireId(tokens[1], action);
        if (action === "enable" || action === "disable") {
          await setTaskEnabled(ctx.cwd, id, action === "enable");
          ctx.ui.notify(`${action === "enable" ? "Enabled" : "Disabled"} ${id}`, "info");
          return;
        }
        if (action === "run") {
          await executeNow(ctx, id);
          return;
        }
        if (action === "remove" || action === "delete") {
          await confirmMutation(ctx, `Delete scheduled task ${id}?`);
          await removeTask(ctx.cwd, id);
          ctx.ui.notify(`Removed ${id}`, "info");
          return;
        }
        throw new Error("Usage: /schedule [list|add|enable|disable|run|remove|runs|open|clear] <id>");
      });
    },
  });

  pi.registerCommand("unschedule", {
    description: "Delete a scheduled task: /unschedule <id>",
    handler: async (args, ctx) => {
      await guard(ctx, async () => {
        const id = args.trim();
        if (!id) throw new Error("Usage: /unschedule <id>");
        await confirmMutation(ctx, `Delete scheduled task ${id}?`);
        await removeTask(ctx.cwd, id);
        ctx.ui.notify(`Removed ${id}`, "info");
      });
    },
  });
}

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

async function guard(ctx: CommandContext, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

async function executeNow(ctx: CommandContext, id: string): Promise<void> {
  const outcome = await runTask(ctx.cwd, id, {});
  if (outcome.status === "skipped") {
    ctx.ui.notify("Another agent-cron invocation is running; try again shortly.", "warning");
    return;
  }
  ctx.ui.notify(`${outcome.status}: ${outcome.taskId} (${outcome.runId})`, outcome.status === "error" ? "error" : "info");
}

function parseReminder(args: string): { runAt: string; prompt: string } {
  const inMatch = /^\s*in\s+(\S+)\s+([\s\S]+?)\s*$/i.exec(args);
  if (inMatch) {
    return {
      runAt: new Date(Date.now() + parseDuration(inMatch[1])).toISOString(),
      prompt: inMatch[2],
    };
  }

  const atMatch = /^\s*at\s+(\d{1,2}):(\d{2})\s+([\s\S]+?)\s*$/i.exec(args);
  if (!atMatch) throw new Error("Usage: /remind in <duration> <prompt> or /remind at HH:MM <prompt>");
  const hour = Number(atMatch[1]);
  const minute = Number(atMatch[2]);
  if (hour > 23 || minute > 59) throw new Error("Time must be in HH:MM format");
  const runAt = new Date();
  runAt.setHours(hour, minute, 0, 0);
  if (runAt.getTime() <= Date.now()) runAt.setDate(runAt.getDate() + 1);
  return { runAt: runAt.toISOString(), prompt: atMatch[3] };
}

function requireId(value: string | undefined, action: string): string {
  if (!value) throw new Error(`/schedule ${action} requires a task id`);
  return value;
}

export function formatTask(task: ScheduleTask): string {
  return `${task.id} [${task.enabled ? "enabled" : "disabled"}] ${task.name ?? "-"} — ${formatSchedule(task)} — next ${formatDate(task.nextRunAt)}`;
}

export function formatRun(run: RunRecord): string {
  const when = run.finishedAt ?? run.startedAt;
  return `${run.runId} [${run.status}] ${run.trigger} — ${formatDate(when)}${run.sessionFile ? ` — ${run.sessionFile}` : ""}`;
}

function formatSchedule(task: ScheduleTask): string {
  if (task.schedule.kind === "interval") return `every ${task.schedule.everyMs}ms`;
  if (task.schedule.kind === "cron") return `cron ${task.schedule.expression}`;
  return `once ${task.schedule.runAt}`;
}

function formatDate(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : "never";
}
