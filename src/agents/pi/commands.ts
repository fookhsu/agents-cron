import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readRun, listRunsForTask } from "../../runs.ts";
import { runTask } from "../../runner.ts";
import { normalizeChannelIds } from "../../notify/config.ts";
import { schedulerPaths } from "../../paths.ts";
import { parseDuration, parseScheduleSpec } from "../../scheduling.ts";
import { addTask, assertThinkingLevel, clearTasks, describeOverrides, exportTasks, importTasks, listTasks, removeTask, requireTask, setTaskEnabled, updateTask, type TaskPatch } from "../../task-service.ts";
import { parseExportFile } from "../../task-export.ts";
import { confirmMutation } from "./confirm.ts";
import {
  remindArgumentCompletions,
  rememberProjectCwd,
  SCHEDULE_ACTIONS,
  scheduleArgumentCompletions,
  taskSpecArgumentCompletions,
} from "./completions.ts";
import { formatDate, formatRun, formatTask, previewPrompt } from "./format.ts";
import { readOwnChangelog } from "./update-notice.ts";

/** The default file /schedule export writes: definitions only, review-friendly. */
const DEFAULT_EXPORT_FILE = "agents-cron.tasks.json";

export function registerCommands(pi: ExtensionAPI): void {
  // Completions run while the user types, with no ctx; session_start (and
  // every command invocation, via guard) is where the project dir is learned.
  pi.on("session_start", (_event, ctx) => rememberProjectCwd(ctx.cwd));

  pi.registerCommand("loop", {
    description: 'Create a recurring task: /loop 30m check CI, or /loop "*/5 * * * *" check CI --to feishu',
    getArgumentCompletions: taskSpecArgumentCompletions,
    handler: async (args, ctx) => {
      await guard(ctx, async () => {
        await addFromSpec(ctx, "/loop", args);
      });
    },
  });

  pi.registerCommand("remind", {
    description: "Create a one-time task: /remind in 45m check the PR --to feishu --notify always",
    getArgumentCompletions: remindArgumentCompletions,
    handler: async (args, ctx) => {
      await guard(ctx, async () => {
        const flags = parseTrailingFlags(args);
        const parsed = parseReminder(flags.rest);
        const task = await addTask(ctx.cwd, {
          prompt: parsed.prompt,
          schedule: { kind: "once", runAt: parsed.runAt },
          ...(flags.notify ? { notify: flags.notify } : {}),
          ...(flags.to ? { notifyTo: flags.to } : {}),
          ...(flags.agent ? { agent: flags.agent } : {}),
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.thinking ? { thinking: flags.thinking } : {}),
        });
        ctx.ui.notify(`Created ${task.id}; scheduled for ${formatDate(task.nextRunAt)}`, "info");
      });
    },
  });

  pi.registerCommand("schedule", {
    description: "List and manage scheduled tasks — /schedule help shows usage",
    getArgumentCompletions: scheduleArgumentCompletions,
    handler: async (args, ctx) => {
      await guard(ctx, async () => {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const action = tokens[0] ?? "list";
        const paths = schedulerPaths(ctx.cwd);

        if (action === "help") {
          ctx.ui.notify(SCHEDULE_HELP, "info");
          return;
        }
        if (action === "list") {
          const tasks = await listTasks(ctx.cwd);
          ctx.ui.notify(tasks.length ? tasks.map(formatTask).join("\n") : "No scheduled tasks.", "info");
          return;
        }
        if (action === "add") {
          await addFromSpec(ctx, "/schedule add", args.replace(/^\s*add\s+/, ""));
          return;
        }
        if (action === "runs") {
          const id = requireId(tokens[1], "runs");
          const runs = await listRunsForTask(paths.runsDir, id);
          ctx.ui.notify(runs.length ? runs.map(formatRun).join("\n") : `No runs for ${id}.`, "info");
          return;
        }
        if (action === "set") {
          const id = requireId(tokens[1], "set");
          const patch = parseSetSpec(args.replace(/^\s*set\s+\S+\s*/, ""));
          const task = await updateTask(ctx.cwd, id, patch);
          const overrides = describeOverrides(task);
          ctx.ui.notify(
            `Updated ${task.id}${overrides.length ? ` — ${overrides.join("; ")}` : " — no overrides; runs use the project and user defaults"}`,
            "info",
          );
          return;
        }
        if (action === "show") {
          const id = requireId(tokens[1], "show");
          const task = requireTask(await listTasks(ctx.cwd), id);
          const meta = [
            task.agent ? `agent: ${task.agent}` : undefined,
            task.model ? `model: ${task.model}` : undefined,
            task.thinking ? `thinking: ${task.thinking}` : undefined,
            task.cwd ? `cwd: ${task.cwd}` : undefined,
            task.tools?.length ? `tools: ${task.tools.join(", ")}` : undefined,
            task.notify ? `notify: ${task.notify}` : undefined,
            task.notifyTo?.length ? `notify to: ${task.notifyTo.join(", ")}` : undefined,
          ].filter(Boolean);
          ctx.ui.notify([formatTask(task), ...meta, `prompt:\n${task.prompt}`].join("\n"), "info");
          return;
        }
        if (action === "changelog") {
          const changelog = await readOwnChangelog();
          ctx.ui.notify(changelog ?? "No changelog bundled; see https://github.com/fookhsu/agents-cron/releases", "info");
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

        if (action === "export") {
          const rest = tokens.slice(1);
          const all = rest.includes("--all");
          const named = rest.filter((token) => token !== "--all")[0];
          const target = named ? resolve(ctx.cwd, named) : join(ctx.cwd, DEFAULT_EXPORT_FILE);
          const file = await exportTasks(ctx.cwd, all ? { all: true } : {});
          await writeFile(target, `${JSON.stringify(file, null, 2)}\n`, "utf8");
          ctx.ui.notify(`Exported ${file.tasks.length} task(s) to ${target}`, "info");
          return;
        }
        if (action === "import") {
          const file = tokens[1];
          if (!file) throw new Error("Usage: /schedule import <file> — export one first with /schedule export [file]");
          let raw: string;
          try {
            raw = await readFile(resolve(ctx.cwd, file), "utf8");
          } catch (error) {
            throw new Error(`Cannot read task export ${file}: ${(error as Error).message}`);
          }
          const parsed = parseExportFile(raw);
          const report = await importTasks(ctx.cwd, parsed.tasks);
          const lines = [`Imported ${report.created.length} task(s); all start disabled`];
          for (const task of report.created) lines.push(`  created ${task.id} — ${task.name ?? previewPrompt(task.prompt)}`);
          for (const skip of report.skipped) {
            lines.push(`  skipped "${skip.entry.name ?? previewPrompt(skip.entry.prompt)}" — ${skip.reason}`);
          }
          for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
          if (report.created.length > 0) lines.push("Review the prompts, then enable one by one: /schedule enable <id>");
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        if (action === "clear") {
          await confirmMutation(ctx, "Delete all scheduled tasks?");
          ctx.ui.notify(`Cleared ${await clearTasks(ctx.cwd)} task(s)`, "info");
          return;
        }

        if (action === "enable" || action === "disable") {
          const id = requireId(tokens[1], action);
          await setTaskEnabled(ctx.cwd, id, action === "enable");
          ctx.ui.notify(`${action === "enable" ? "Enabled" : "Disabled"} ${id}`, "info");
          return;
        }
        if (action === "run") {
          await executeNow(ctx, requireId(tokens[1], action));
          return;
        }
        if (action === "remove") {
          const id = requireId(tokens[1], action);
          await confirmMutation(ctx, `Delete scheduled task ${id}?`);
          await removeTask(ctx.cwd, id);
          ctx.ui.notify(`Removed ${id}`, "info");
          return;
        }
        throw new Error(`Unknown action "${action}".\n${SCHEDULE_HELP}`);
      });
    },
  });
}

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

type NotifyLevel = "always" | "error" | "never";

type TrailingFlags = {
  to?: string[];
  notify?: NotifyLevel;
  agent?: string;
  model?: string;
  thinking?: string;
  rest: string;
};

/** How /schedule set spells its flags, mapped to TaskPatch keys. */
const SET_FLAG_TO_FIELD: Record<string, "name" | "agent" | "model" | "thinking" | "cwd" | "tools" | "notify" | "notifyTo"> = {
  "--name": "name",
  "--agent": "agent",
  "--model": "model",
  "--thinking": "thinking",
  "--cwd": "cwd",
  "--tools": "tools",
  "--notify": "notify",
  "--notify-to": "notifyTo",
  "--to": "notifyTo",
};

const SET_USAGE =
  "Usage: /schedule set <id> --model <id> --thinking <level> --agent <id> --name <text> --cwd <path> --tools a,b --notify <level> --to <ids> — a value of - clears a field";

/**
 * The one creation path behind /loop and /schedule add: spec first, prompt
 * after, trailing routing flags allowed. The usage error names the command
 * the user actually typed.
 */
async function addFromSpec(ctx: CommandContext, command: string, args: string): Promise<void> {
  const flags = parseTrailingFlags(args);
  const match = /^\s*("[^"]*"|\S+)\s+([\s\S]+?)\s*$/.exec(flags.rest);
  if (!match) {
    throw new Error(
      `Usage: ${command} <duration|cron> <prompt> — duration is a number + unit (30s, 5m, 2h, 1d); cron is quoted like "*/5 * * * *" or a nickname like @daily`,
    );
  }
  const task = await addTask(ctx.cwd, {
    prompt: match[2],
    schedule: parseScheduleSpec(match[1]),
    ...(flags.notify ? { notify: flags.notify } : {}),
    ...(flags.to ? { notifyTo: flags.to } : {}),
    ...(flags.agent ? { agent: flags.agent } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.thinking ? { thinking: flags.thinking } : {}),
  });
  ctx.ui.notify(`Created ${task.id}; next run ${formatDate(task.nextRunAt)}`, "info");
}

/**
 * Parses the flag list /schedule set accepts: `--flag value` pairs after the
 * task id. `-` clears a field (drops the override); list flags take a
 * comma-separated value; a value may be quoted once for --name.
 */
export function parseSetSpec(rest: string): TaskPatch {
  const patch: TaskPatch = {};
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; ) {
    const flag = tokens[index];
    const field = SET_FLAG_TO_FIELD[flag];
    if (!field) throw new Error(`Unexpected "${flag}". ${SET_USAGE}`);
    let value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value. ${SET_USAGE}`);
    index += 2;
    // A quoted value may span tokens: --name "night audit".
    if (value.startsWith('"') && !value.endsWith('"')) {
      const end = tokens.findIndex((token, i) => i >= index && token.endsWith('"'));
      if (end === -1) throw new Error(`${flag} is missing its closing quote. ${SET_USAGE}`);
      value = [value, ...tokens.slice(index, end + 1)].join(" ");
      index = end + 1;
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (field === "tools" || field === "notifyTo") {
      const items = value === "-" ? [] : value.split(",").map((item) => item.trim()).filter(Boolean);
      if (field === "tools") patch.tools = items;
      else patch.notifyTo = normalizeChannelIds(items);
    } else if (field === "notify") {
      if (value !== "-" && value !== "always" && value !== "error" && value !== "never") {
        throw new Error("--notify must be one of: always, error, never");
      }
      patch.notify = value === "-" ? "" : value;
    } else {
      patch[field] = value === "-" ? "" : value;
    }
  }
  if (!tokens.length) throw new Error(SET_USAGE);
  return patch;
}

/**
 * Strips trailing `--flag value` pairs off a command's args, in any order,
 * so the prompt never has to carry them. Routing (`--to`, `--notify`) and
 * model config (`--agent`, `--model`, `--thinking`) are recognized; a value
 * of `-` on a model flag means "none" and is dropped. Only trailing flags
 * are recognized — a `--to` mid-prompt stays part of the prompt.
 */
export function parseTrailingFlags(args: string): TrailingFlags {
  let rest = args.trim();
  let to: string[] | undefined;
  let notify: NotifyLevel | undefined;
  let agent: string | undefined;
  let model: string | undefined;
  let thinking: string | undefined;
  for (;;) {
    const match = /(?:^|\s)--(notify-to|to|notify|agent|model|thinking)\s+([^\s]+)\s*$/.exec(rest);
    if (!match) break;
    const value = match[2];
    switch (match[1]) {
      case "notify": {
        if (value !== "always" && value !== "error" && value !== "never") {
          throw new Error("--notify must be one of: always, error, never");
        }
        notify = value;
        break;
      }
      case "to":
      case "notify-to": {
        const ids = normalizeChannelIds(value.split(","));
        if (!ids?.length) throw new Error("--to requires at least one channel id");
        to = [...(to ?? []), ...ids];
        break;
      }
      case "thinking": {
        assertThinkingLevel(value);
        thinking = value;
        break;
      }
      case "agent":
        agent = value === "-" ? undefined : value;
        break;
      default:
        model = value === "-" ? undefined : value;
        break;
    }
    rest = rest.slice(0, match.index).trimEnd();
  }
  return {
    ...(to ? { to } : {}),
    ...(notify ? { notify } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    rest,
  };
}

const SCHEDULE_HELP = [
  "Usage: /schedule <action> [args]",
  ...SCHEDULE_ACTIONS.map(
    (action) => `  ${action.usage.padEnd(Math.max(...SCHEDULE_ACTIONS.map((a) => a.usage.length)) + 1)}${action.description}`,
  ),
  "Trailing flags on /loop, /remind, and /schedule add:",
  "  --model <id>           model for this task's runs (provider/id, :level shorthand ok)",
  "  --thinking <level>     off, minimal, low, medium, high, xhigh, max",
  "  --agent <id>           pi, claude, or codex",
  "  --to <id,id>           route this task's notifications to those channels",
  "  --notify-to <id,id>    alias of --to (the CLI spelling)",
  "  --notify <level>       always, error (project default), or never",
  "Configure an existing task: /schedule set <id> --model <id> --thinking <level> ...",
  "  — same flags; a value of - clears a field back to the project and user defaults",
  "Related: /loop <spec> <prompt>, /remind in 45m <prompt>",
].join("\n");

async function guard(ctx: CommandContext, run: () => Promise<void>): Promise<void> {
  rememberProjectCwd(ctx.cwd);
  try {
    await run();
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

async function executeNow(ctx: CommandContext, id: string): Promise<void> {
  const outcome = await runTask(ctx.cwd, id, {});
  if (outcome.status === "skipped") {
    ctx.ui.notify("Another agents-cron invocation is running; try again shortly.", "warning");
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
  if (!atMatch) {
    throw new Error(
      "Usage: /remind in <duration> <prompt> or /remind at HH:MM <prompt> — duration is a number + unit (30s, 5m, 2h, 1d); HH:MM is 24-hour local time, a past time runs tomorrow",
    );
  }
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
