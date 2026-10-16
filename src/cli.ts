import { resolve } from "node:path";
import "./agents/builtin.ts";
import type { AgentRegistry } from "./agents/registry.ts";
import { schedulerPaths } from "./paths.ts";
import { listRuns, pruneRuns } from "./runs.ts";
import { runDue, runTask, TaskNotFoundError } from "./runner.ts";
import type { ScheduleInput } from "./scheduling.ts";
import { addTask, clearTasks, listTasks, removeTask, setTaskEnabled } from "./task-service.ts";
import type { RunRecord, ScheduleTask } from "./types.ts";

const USAGE = [
  "pi-scheduler <command> [options]",
  "",
  "  run-due [--project <path>] [--agent <id>]   Execute every due task (cron entry point)",
  "  run <taskId> [--project <path>] [--agent <id>]   Execute one task now",
  "  list [--project <path>] [--json]        List tasks and their latest run",
  "  add --prompt <text> (--at <iso>|--every <duration>|--cron <expr>) [options]",
  "  enable <taskId> | disable <taskId> | remove <taskId>",
  "  prune --keep <n> [--project <path>]     Keep the newest n runs per task",
  "",
  "Agents: --agent <id> selects the agent adapter — built in: pi, claude (default: pi).",
].join("\n");

export type CliDeps = {
  agents?: AgentRegistry;
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
};

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv, deps.cwd ?? process.cwd());
  } catch (error) {
    err(errorMessage(error));
    return 2;
  }

  const { command, project, positional, flags } = parsed;
  try {
    switch (command) {
      case "help":
        out(USAGE);
        return 0;
      case "run-due":
        return await commandRunDue(project, flags, deps, out);
      case "run": {
        const id = requireArgument(positional[0], "run requires a task id");
        const outcome = await runTask(project, id, {
          agents: deps.agents,
          agent: stringFlag(flags, "agent"),
        });
        out(`${outcome.status}: ${outcome.taskId} (${outcome.runId || "not started"})`);
        return outcome.status === "error" ? 1 : 0;
      }
      case "list":
        return await commandList(project, flags, out);
      case "add":
        return await commandAdd(project, flags, out);
      case "enable":
      case "disable": {
        const id = requireArgument(positional[0], `${command} requires a task id`);
        const task = await setTaskEnabled(project, id, command === "enable");
        out(`${task.enabled ? "Enabled" : "Disabled"} ${task.id}`);
        return 0;
      }
      case "remove": {
        const id = requireArgument(positional[0], "remove requires a task id");
        await removeTask(project, id);
        out(`Removed ${id}`);
        return 0;
      }
      case "clear": {
        out(`Cleared ${await clearTasks(project)} task(s)`);
        return 0;
      }
      case "prune":
        return await commandPrune(project, flags, out);
      default:
        err(`Unknown command: ${command}`);
        err(USAGE);
        return 2;
    }
  } catch (error) {
    err(errorMessage(error));
    return 2;
  }
}

async function commandRunDue(
  project: string,
  flags: Map<string, string | boolean>,
  deps: CliDeps,
  out: (line: string) => void,
): Promise<number> {
  const result = await runDue({
    projectDir: project,
    agents: deps.agents,
    agent: stringFlag(flags, "agent"),
  });
  if (result.skipped) {
    out("Another pi-scheduler instance owns the run lock; skipped.");
    return 0;
  }
  for (const run of result.runs) out(`${run.status}: ${run.taskId} (${run.runId})`);
  if (result.runs.length === 0) out("No due tasks.");
  return result.failures > 0 ? 1 : 0;
}

async function commandList(
  project: string,
  flags: Map<string, string | boolean>,
  out: (line: string) => void,
): Promise<number> {
  const tasks = await listTasks(project);
  if (flags.has("json")) {
    out(JSON.stringify(tasks, null, 2));
    return 0;
  }
  if (tasks.length === 0) {
    out("No scheduled tasks.");
    return 0;
  }
  const runs = await listRuns(schedulerPaths(project).runsDir);
  for (const task of tasks) {
    const latest = runs.find((run) => run.taskId === task.id);
    out(formatTaskLine(task, latest));
  }
  return 0;
}

async function commandAdd(
  project: string,
  flags: Map<string, string | boolean>,
  out: (line: string) => void,
): Promise<number> {
  const prompt = requireArgument(stringFlag(flags, "prompt"), "add requires --prompt");
  const task = await addTask(project, {
    prompt,
    schedule: scheduleFromFlags(flags),
    name: stringFlag(flags, "name"),
    agent: stringFlag(flags, "agent"),
    model: stringFlag(flags, "model"),
    thinking: stringFlag(flags, "thinking"),
    cwd: stringFlag(flags, "cwd"),
    tools: stringFlag(flags, "tools")
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean),
  });
  out(`Created ${task.id}; next run ${task.nextRunAt ?? "never"}`);
  return 0;
}

async function commandPrune(
  project: string,
  flags: Map<string, string | boolean>,
  out: (line: string) => void,
): Promise<number> {
  const keep = Number(stringFlag(flags, "keep") ?? "20");
  if (!Number.isInteger(keep) || keep < 0) throw new Error("--keep must be a non-negative integer");
  out(`Pruned ${await pruneRuns(schedulerPaths(project).runsDir, keep)} run(s)`);
  return 0;
}

function scheduleFromFlags(flags: Map<string, string | boolean>): ScheduleInput {
  const at = stringFlag(flags, "at");
  const every = stringFlag(flags, "every");
  const cron = stringFlag(flags, "cron");
  const chosen = [at, every, cron].filter(Boolean).length;
  if (chosen !== 1) throw new Error("add requires exactly one of --at, --every, or --cron");
  if (at) return { kind: "once", runAt: at };
  if (every) return { kind: "interval", every };
  return { kind: "cron", expression: cron!, timezone: stringFlag(flags, "timezone") };
}

function formatTaskLine(task: ScheduleTask, latestRun?: RunRecord): string {
  const state = task.enabled ? "enabled" : "disabled";
  const schedule = task.schedule.kind === "interval"
    ? `every ${task.schedule.everyMs}ms`
    : task.schedule.kind === "cron"
      ? `cron ${task.schedule.expression}`
      : `once ${task.schedule.runAt}`;
  const last = latestRun ? ` — last ${latestRun.status} at ${latestRun.finishedAt ?? latestRun.startedAt}` : "";
  return `${task.id} [${state}] ${task.name ?? "-"} — ${schedule} — next ${task.nextRunAt ?? "never"}${last}`;
}

type ParsedArgs = {
  command: string;
  project: string;
  positional: string[];
  flags: Map<string, string | boolean>;
};

const BOOLEAN_FLAGS = new Set(["json"]);

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let project = cwd;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") {
      project = resolve(cwd, requireArgument(argv[++index], "--project requires a path"));
      continue;
    }
    if (token.startsWith("--project=")) {
      project = resolve(cwd, token.slice("--project=".length));
      continue;
    }
    if (token.startsWith("--")) {
      const [name, inlineValue] = splitFlag(token);
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
        continue;
      }
      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      flags.set(name, value);
      index += 1;
      continue;
    }
    positional.push(token);
  }

  const [command = "help", ...rest] = positional;
  return { command, project, positional: rest, flags };
}

function splitFlag(token: string): [string, string | undefined] {
  const body = token.slice(2);
  const equals = body.indexOf("=");
  return equals >= 0 ? [body.slice(0, equals), body.slice(equals + 1)] : [body, undefined];
}

function stringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requireArgument(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof TaskNotFoundError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
