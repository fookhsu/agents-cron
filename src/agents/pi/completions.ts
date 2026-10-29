import { CRON_NICKNAMES } from "../../scheduling.ts";
import { loadNotifyConfig } from "../../notify/config.ts";
import { listTasks } from "../../task-service.ts";
import { listRuns } from "../../runs.ts";
import { schedulerPaths } from "../../paths.ts";
import { resolve } from "node:path";
import type { RunRecord, ScheduleTask } from "../../types.ts";
import { formatDate, formatSchedule, previewPrompt } from "./format.ts";

/**
 * Argument completion ("命令联想") for the three slash commands. Pi's TUI
 * fuzzy-completes command names on its own; once a space follows the name it
 * calls `getArgumentCompletions(argumentPrefix)` with everything typed so far
 * and swaps the whole argument string for the picked item's value. That
 * contract shapes everything here: items are full replacement strings, and
 * filtering is ours to do.
 *
 * Structure: pure suggesters over in-memory data (exported for tests), plus
 * thin async wrappers that read the store. The wrappers must never throw —
 * a completion error would break typing, not just the suggestion.
 */

/** Structurally pi-tui's AutocompleteItem, which the pi index does not re-export. */
export type CompletionItem = { value: string; label: string; description?: string };

export type ScheduleAction = { name: string; usage: string; description: string };

/**
 * One source of truth for /schedule's action surface: the help text renders
 * it, the completions suggest it, and the id-taking actions are derived from
 * the `<id>` / `<runId>` placeholders in `usage` rather than listed again.
 */
export const SCHEDULE_ACTIONS: readonly ScheduleAction[] = [
  { name: "list", usage: "list", description: "list tasks (default action)" },
  { name: "add", usage: "add <spec> <prompt>", description: 'create a task; spec: 30m, @daily, or "0 9 * * 1-5"' },
  { name: "enable", usage: "enable <id>", description: "resume a paused task" },
  { name: "disable", usage: "disable <id>", description: "pause a task" },
  { name: "run", usage: "run <id>", description: "run a task now; its schedule is untouched" },
  { name: "remove", usage: "remove <id>", description: "delete a task" },
  { name: "runs", usage: "runs <id>", description: "list run records" },
  { name: "show", usage: "show <id>", description: "show a task's scheduling facts and prompt" },
  { name: "open", usage: "open <runId>", description: "show a run's Task Session path" },
  { name: "export", usage: "export [file] [--all]", description: "write task definitions as JSON (default agents-cron.tasks.json)" },
  { name: "import", usage: "import <file>", description: "import definitions into this project; tasks start disabled" },
  { name: "changelog", usage: "changelog", description: "show the shipped changelog" },
  { name: "clear", usage: "clear", description: "delete all tasks" },
  { name: "help", usage: "help", description: "show this help" },
];

const NOTIFY_LEVELS = ["always", "error", "never"] as const;

/** A notification channel as seen by completion: its routing id and type. */
export type ChannelOption = { id: string; type: string };

/**
 * Where the cursor's word stands. `tokens` are the words before it; `partial`
 * is the word being typed, "" when the args end on a word boundary.
 */
export function splitCompleting(args: string): { tokens: string[]; partial: string } {
  if (args === "") return { tokens: [], partial: "" };
  const parts = args.split(/\s+/);
  const startingWord = /\s$/.test(args);
  const partial = startingWord ? "" : (parts[parts.length - 1] ?? "");
  const tokens = (startingWord ? parts : parts.slice(0, -1)).filter(Boolean);
  return { tokens, partial };
}

function actionsWithPlaceholder(placeholder: string): string[] {
  return SCHEDULE_ACTIONS.filter((action) => action.usage.includes(placeholder)).map((action) => action.name);
}

export function completeScheduleActions(partial: string): CompletionItem[] | null {
  const matched = SCHEDULE_ACTIONS.filter((action) => action.name.startsWith(partial));
  return matched.length
    ? matched.map((action) => ({ value: action.name, label: action.name, description: action.description }))
    : null;
}

/** Which store data the args could possibly need, so the wrapper reads no more than that. */
export function scheduleCompletionNeeds(args: string): { tasks: boolean; runs: boolean } | null {
  const { tokens, partial } = splitCompleting(args);
  if (tokens.length === 0) return { tasks: false, runs: false };
  if (tokens.length > 1) return null;
  const action = tokens[0];
  if (actionsWithPlaceholder("<id>").includes(action)) return { tasks: true, runs: false };
  if (actionsWithPlaceholder("<runId>").includes(action)) return { tasks: false, runs: true };
  if (action === "export" && partial.startsWith("-")) return { tasks: false, runs: false };
  return null;
}

export function completeScheduleArguments(
  args: string,
  tasks: readonly ScheduleTask[],
  runs: readonly RunRecord[],
  sessionProjectDir?: string,
): CompletionItem[] | null {
  const { tokens, partial } = splitCompleting(args);
  if (tokens.length === 0) return completeScheduleActions(partial);
  if (tokens.length > 1) return null;
  const action = tokens[0];

  if (actionsWithPlaceholder("<id>").includes(action)) {
    // listTasks is the Project View — every registry task, the session's
    // project first — and id resolution is registry-wide, so all ids are
    // suggestable; foreign tasks just say where they live.
    const matched = tasks.filter((task) => task.id.startsWith(partial));
    return matched.length
      ? matched.map((task) => ({
          value: `${action} ${task.id}`,
          label: task.id,
          description: [
            `${task.enabled ? "enabled" : "disabled"} — ${formatSchedule(task)} — ${task.name ?? previewPrompt(task.prompt)}`,
            ...(sessionProjectDir && task.projectDir !== sessionProjectDir ? [`in ${task.projectDir}`] : []),
          ].join(" — "),
        }))
      : null;
  }

  if (actionsWithPlaceholder("<runId>").includes(action)) {
    const matched = runs.filter((run) => run.runId.startsWith(partial)).slice(0, 15);
    return matched.length
      ? matched.map((run) => ({
          value: `${action} ${run.runId}`,
          label: run.runId,
          description: `[${run.status}] ${run.trigger} — ${formatDate(run.finishedAt ?? run.startedAt)}`,
        }))
      : null;
  }

  if (action === "export" && partial.startsWith("-")) {
    return [{ value: "export --all", label: "--all", description: "include every project's tasks, not just this one" }];
  }
  return null;
}

/** True when the args end inside a `--to`/`--notify` value, so channel config is worth reading. */
export function endsInRoutingFlag(args: string): boolean {
  return /(?:^|\s)--notify(?:\s+\S*)?$/.test(args) || /(?:^|\s)--(?:notify-)?to(?:\s+\S*)?$/.test(args);
}

function joinArgs(head: string, tail: string): string {
  return head.trimEnd() ? `${head.trimEnd()} ${tail}` : tail;
}

/**
 * Completes the trailing routing flags every creation command accepts. The
 * `--to` value is a comma-separated id list, so the segment after the last
 * comma is completed and already-typed ids are deduped away.
 */
export function completeTrailingFlags(args: string, channels: readonly ChannelOption[]): CompletionItem[] | null {
  const notify = /(?:^|\s)(--notify)(?:\s+(\S*))?$/.exec(args);
  if (notify) {
    const partial = notify[2] ?? "";
    const levels = NOTIFY_LEVELS.filter((level) => level.startsWith(partial));
    const levelDescriptions: Record<(typeof NOTIFY_LEVELS)[number], string> = {
      always: "announce every run",
      error: "only failed runs (project default)",
      never: "no notifications",
    };
    return levels.length
      ? levels.map((level) => ({
          value: joinArgs(args.slice(0, notify.index), `--notify ${level}`),
          label: level,
          description: levelDescriptions[level],
        }))
      : null;
  }

  const to = /(?:^|\s)(--(?:notify-)?to)(?:\s+(\S*))?$/.exec(args);
  if (to) {
    const segments = (to[2] ?? "").split(",");
    const typed = segments.pop() ?? "";
    const matched = channels.filter((channel) => channel.id.startsWith(typed) && !segments.includes(channel.id));
    return matched.length
      ? matched.map((channel) => ({
          value: joinArgs(args.slice(0, to.index), `${to[1]} ${[...segments, channel.id].join(",")}`),
          label: channel.id,
          description: channel.type,
        }))
      : null;
  }
  return null;
}

/** Suggests cron nicknames while the schedule spec (first word) is being typed. */
export function completeCronNickname(args: string): CompletionItem[] | null {
  if (/\s/.test(args) || !args.startsWith("@")) return null;
  const matched = Object.entries(CRON_NICKNAMES).filter(([name]) => name.startsWith(args.toLowerCase()));
  return matched.length
    ? matched.map(([name, expression]) => ({ value: name, label: name, description: expression }))
    : null;
}

/** Suggests /remind's two keyword shapes while the first word is being typed. */
export function completeReminderShape(args: string): CompletionItem[] | null {
  if (/\s/.test(args)) return null;
  const shapes = [
    { value: "in", description: "relative — in 45m <prompt>" },
    { value: "at", description: "local clock time — at 09:30 <prompt>" },
  ];
  const matched = shapes.filter((shape) => shape.value.startsWith(args.toLowerCase()));
  return matched.length ? matched.map(({ value, description }) => ({ value, label: value, description })) : null;
}

/**
 * Completion runs while the user types and gets no ctx, so the session's
 * project dir is remembered here — from `session_start` and from every
 * command invocation, whichever comes first.
 */
let projectCwd: string | undefined;

export function rememberProjectCwd(cwd: string): void {
  projectCwd = cwd;
}

async function channelOptions(cwd: string): Promise<ChannelOption[]> {
  const config = await loadNotifyConfig(schedulerPaths(cwd).dir);
  return config.channels.map((channel) => ({ id: channel.id, type: channel.type }));
}

async function routingFlagCompletions(args: string): Promise<CompletionItem[] | null> {
  const cwd = projectCwd;
  if (!cwd || !endsInRoutingFlag(args)) return null;
  return completeTrailingFlags(args, await channelOptions(cwd));
}

/** `getArgumentCompletions` for /loop (and `/schedule add`, prefixed by its caller). */
export async function taskSpecArgumentCompletions(args: string): Promise<CompletionItem[] | null> {
  try {
    return (await routingFlagCompletions(args)) ?? completeCronNickname(args);
  } catch {
    return null;
  }
}

/** `getArgumentCompletions` for /remind. */
export async function remindArgumentCompletions(args: string): Promise<CompletionItem[] | null> {
  try {
    return (await routingFlagCompletions(args)) ?? completeReminderShape(args);
  } catch {
    return null;
  }
}

/** `getArgumentCompletions` for /schedule. */
export async function scheduleArgumentCompletions(args: string): Promise<CompletionItem[] | null> {
  const cwd = projectCwd;
  if (!cwd) return null;
  try {
    const { tokens } = splitCompleting(args);
    if (tokens[0] === "add") {
      // The rest is a /loop-shaped spec + prompt; inner values replace only
      // that tail, so re-attach the "add" the user already typed.
      const rest = args.replace(/^\s*add\s+/, "");
      const inner = await taskSpecArgumentCompletions(rest);
      return inner?.map((item) => ({ ...item, value: `add ${item.value}` })) ?? null;
    }

    const needs = scheduleCompletionNeeds(args);
    if (!needs) return null;
    const paths = schedulerPaths(cwd);
    const [tasks, runs] = await Promise.all([
      needs.tasks ? listTasks(cwd) : Promise.resolve([]),
      needs.runs ? listRuns(paths.runsDir) : Promise.resolve([]),
    ]);
    return completeScheduleArguments(args, tasks, runs, resolve(cwd));
  } catch {
    return null;
  }
}
