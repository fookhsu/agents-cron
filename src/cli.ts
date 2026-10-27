import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./agents/builtin.ts";
import { PI_STORE_ENV } from "./agents/pi/adapter.ts";
import { migratePiSessions } from "./agents/pi/migrate.ts";
import type { AgentRegistry } from "./agents/registry.ts";
import { acquireLock } from "./lock.ts";
import { loadNotifyConfig, normalizeChannelIds } from "./notify/config.ts";
import { notifiersFor } from "./notify/dispatch.ts";
import type { ChannelId, RunNotification } from "./notify/types.ts";
import { schedulerPaths } from "./paths.ts";
import { loadRegistry } from "./registry.ts";
import { listRuns, pruneRuns } from "./runs.ts";
import { runDue, runTask, TaskNotFoundError } from "./runner.ts";
import type { ScheduleInput } from "./scheduling.ts";
import { addTask, clearTasks, listTasks, removeTask, requireTask, setTaskEnabled } from "./task-service.ts";
import type { RunRecord, ScheduleTask } from "./types.ts";

const USAGE = [
  "agents-cron <command> [options]",
  "",
  "  run-due [--project <path>|--all] [--agent <id>]   Execute due tasks (cron entry point)",
  "  run <taskId> [--project <path>] [--agent <id>]   Execute one task now",
  "  list [--json]                          List tasks: current project first, then others",
  "  show <taskId> [--json]                  Show one task: scheduling facts and its prompt",
  "  add --prompt <text> (--at <iso>|--every <duration>|--cron <expr>) [options]",
  "  enable <taskId> | disable <taskId> | remove <taskId>",
  "  prune --keep <n> [--project <path>]     Keep the newest n runs per task",
  "  dashboard [--port <n>] [--project <path>]   Serve a local read-only dashboard",
  "  migrate-sessions [--dry-run] [--project <path>]   Carry legacy transcripts into Pi's session store",
  "  test-notify [--channel <id>] [--project <path>]   Send a test notification",
  "  setup-notify                        Interactive email/Feishu channel wizard",
  "",
  "Agents: --agent <id> selects the agent adapter — built in: pi, claude, codex (default: pi).",
  "add options: --name --agent --model --thinking --cwd --tools a,b --notify always|error|never --notify-to a,b",
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

  const { command, project, explicitProject, positional, flags } = parsed;
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
      case "show": {
        const id = requireArgument(positional[0], "show requires a task id");
        return await commandShow(project, flags, id, out);
      }
      case "add":
        return await commandAdd(project, flags, out, err);
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
        return await commandPrune(project, explicitProject, flags, out);
      case "dashboard":
        return await commandDashboard(project, flags, out, err);
      case "migrate-sessions":
        return await commandMigrateSessions(project, explicitProject, flags, out, err);
      case "test-notify":
        return await commandTestNotify(project, flags, out, err);
      case "setup-notify":
        return commandSetupNotify(err);
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
    ...(!flags.has("all") ? { projectDir: project } : {}),
    agents: deps.agents,
    agent: stringFlag(flags, "agent"),
  });
  if (result.skipped) {
    out("Another agents-cron instance owns the run lock; skipped.");
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

  // One ordered list: the current project's tasks plain, then every other
  // project under a header. Ambiguous basenames fall back to full paths.
  const local = resolve(project);
  const basenames = new Map<string, number>();
  for (const task of tasks) {
    const name = basename(task.projectDir);
    basenames.set(name, (basenames.get(name) ?? 0) + 1);
  }
  const latestByProject = new Map<string, RunRecord[]>();
  for (const task of tasks) {
    if (latestByProject.has(task.projectDir)) continue;
    latestByProject.set(task.projectDir, await listRuns(schedulerPaths(task.projectDir).runsDir));
  }

  let previous: string | undefined;
  for (const task of tasks) {
    if (task.projectDir !== local && task.projectDir !== previous) {
      const label = basenames.get(basename(task.projectDir))! > 1 ? task.projectDir : basename(task.projectDir);
      const missing = existsSync(task.projectDir) ? "" : " ⚠ missing directory";
      out("");
      out(`${label}${missing} — ${task.projectDir}`);
      previous = task.projectDir;
    }
    const latest = latestByProject.get(task.projectDir)!.find((run) => run.taskId === task.id);
    out(formatTaskLine(task, latest, task.projectDir === local ? "" : existsSync(task.projectDir) ? "" : " ⚠ missing directory"));
  }
  return 0;
}

/** One task in full: scheduling facts first, then the prompt verbatim. */
async function commandShow(
  project: string,
  flags: Map<string, string | boolean>,
  id: string,
  out: (line: string) => void,
): Promise<number> {
  const task = requireTask(await listTasks(project), id);
  if (flags.has("json")) {
    out(JSON.stringify(task, null, 2));
    return 0;
  }
  out(formatTaskDetail(task));
  return 0;
}

async function commandAdd(
  project: string,
  flags: Map<string, string | boolean>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const prompt = requireArgument(stringFlag(flags, "prompt"), "add requires --prompt");
  const notifyTo = notifyToFlag(flags);
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
    ...(notifyFlag(flags) ? { notify: notifyFlag(flags) } : {}),
    ...(notifyTo ? { notifyTo } : {}),
  });
  out(`Created ${task.id}; next run ${task.nextRunAt ?? "never"}`);
  return 0;
}

/**
 * Spawns the interactive notification wizard. It drives a real terminal
 * (menus, hidden secret entry, browser opening), so it refuses to run when
 * stdout is not a TTY instead of half-working.
 */
function commandSetupNotify(err: (line: string) => void): number {
  if (!process.stdout.isTTY) {
    err("setup-notify is interactive — run it in a terminal.");
    return 2;
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "setup-notify.sh");
  if (!existsSync(script)) {
    err(`Setup wizard not found: ${script}`);
    return 2;
  }
  const result = spawnSync("bash", [script], { stdio: "inherit" });
  return result.status ?? 1;
}

function notifyFlag(flags: Map<string, string | boolean>): "always" | "error" | "never" | undefined {
  const value = stringFlag(flags, "notify");
  if (value === undefined) return undefined;
  if (value === "always" || value === "error" || value === "never") return value;
  throw new Error("--notify must be one of: always, error, never");
}

/** --notify-to a,b — comma-separated channel ids; empty means "no routing". */
function notifyToFlag(flags: Map<string, string | boolean>): ChannelId[] | undefined {
  const value = stringFlag(flags, "notify-to");
  if (value === undefined) return undefined;
  return normalizeChannelIds(value.split(","));
}

/** Sends a synthetic notification through every configured channel (or one). */
async function commandTestNotify(
  project: string,
  flags: Map<string, string | boolean>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const paths = schedulerPaths(project);
  const config = await loadNotifyConfig(paths.dir);
  if (config.channels.length === 0) {
    err(`No notification channels configured in ${join(paths.dir, "config.json")}`);
    err("See the Notifications section of the agents-cron README.");
    return 2;
  }

  const only = stringFlag(flags, "channel");
  const channels = only ? config.channels.filter((channel) => channel.id === only) : config.channels;
  if (channels.length === 0) {
    err(`No channel named ${JSON.stringify(only)} in ${join(paths.dir, "config.json")}`);
    return 2;
  }

  const now = new Date().toISOString();
  const notification: RunNotification = {
    project: basename(project),
    taskId: "task_test0000",
    taskName: "test notification",
    runId: "run_test0000",
    trigger: "manual",
    status: "success",
    exitCode: 0,
    summary: "This is a test notification from agents-cron. If you can read this, the channel works.",
    startedAt: now,
    finishedAt: now,
  };

  const failed: string[] = [];
  await Promise.all(
    notifiersFor({ on: config.on, channels }).map(async (notifier) => {
      try {
        await notifier.send(notification);
        out(`✓ ${notifier.id}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failed.push(notifier.id);
        out(`✗ ${notifier.id}: ${reason}`);
      }
    }),
  );
  return failed.length > 0 ? 1 : 0;
}

async function commandPrune(
  project: string,
  explicitProject: boolean,
  flags: Map<string, string | boolean>,
  out: (line: string) => void,
): Promise<number> {
  const keep = Number(stringFlag(flags, "keep") ?? "20");
  if (!Number.isInteger(keep) || keep < 0) throw new Error("--keep must be a non-negative integer");
  const stores = explicitProject
    ? [schedulerPaths(project)]
    : [...new Set((await loadRegistry()).map((task) => task.projectDir))].map((dir) =>
        schedulerPaths(dir),
      );
  let pruned = 0;
  for (const paths of stores) pruned += await pruneRuns(paths.runsDir, paths.reportsDir, keep);
  out(`Pruned ${pruned} run(s)`);
  return 0;
}

/**
 * Carries legacy private-layout Task Session transcripts into Pi's default
 * session store and rewrites run records to match. Mutates the store, so it
 * holds the run lock; refuses (exit 2) while another instance owns it.
 */
/**
 * Carries legacy private-layout Task Session transcripts into Pi's default
 * session store and rewrites run records to match. Mutates each project's
 * store, so it takes that project's run lock; refuses (exit 2) while another
 * instance owns it. Without an explicit --project it covers every project in
 * the registry, like prune.
 */
async function commandMigrateSessions(
  project: string,
  explicitProject: boolean,
  flags: Map<string, string | boolean>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const dryRun = flags.has("dry-run");
  const projectDirs = explicitProject
    ? [project]
    : [...new Set((await loadRegistry()).map((task) => task.projectDir))];

  if (projectDirs.length === 0) {
    out("Nothing to migrate: no projects in the registry.");
    return 0;
  }

  let exit = 0;
  for (const dir of projectDirs) {
    const paths = schedulerPaths(dir);
    const lock = await acquireLock(paths.lockFile);
    if (!lock) {
      err(`Another agents-cron instance holds ${dir}'s run lock; migrate-sessions refused.`);
      exit = 2;
      continue;
    }
    try {
      const report = await migratePiSessions({ projectDir: dir, dryRun });
      printMigrationReport(report, dir, projectDirs.length > 1, dryRun, out);
    } finally {
      await lock.release();
    }
  }
  return exit;
}

function printMigrationReport(
  report: ReturnType<typeof migratePiSessions> extends Promise<infer R> ? R : never,
  projectDir: string,
  grouped: boolean,
  dryRun: boolean,
  out: (line: string) => void,
): void {
  const prefix = grouped ? `${projectDir}: ` : "";
  const verb = dryRun ? "Would move" : "Moved";
  const total = report.moves.length + report.relinks.length + report.skips.length;
  if (total === 0) {
    out(`${prefix}Nothing to migrate: no run records.`);
    return;
  }
  out(
    `${prefix}${verb} ${report.moves.length} transcript(s) into Pi's session store; ` +
      `relinked ${report.relinks.length}; skipped ${report.skips.length}.`,
  );
  for (const move of report.moves) out(`  ${move.runId} -> ${move.to}`);
  for (const relink of report.relinks) out(`  relinked ${relink.runId} -> ${relink.to}`);
  for (const skip of report.skips) out(`  skipped ${skip.runId} (${skip.reason})`);
  if (!dryRun && !process.env[PI_STORE_ENV]) {
    out(`Note: new runs keep the private layout until ${PI_STORE_ENV}=1 is set.`);
  }
}

/**
 * Serves the read-only dashboard until interrupted. The server is localhost
 * only and mutates nothing, so it never touches the run lock.
 */
async function commandDashboard(
  project: string,
  flags: Map<string, string | boolean>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const { startDashboard, DEFAULT_DASHBOARD_PORT } = await import("./dashboard/server.ts");
  const port = Number(stringFlag(flags, "port") ?? DEFAULT_DASHBOARD_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }

  const handle = await startDashboard({ projectDir: project, port });
  out(`agents-cron dashboard: ${handle.url}`);
  out("Read-only view of tasks and runs. Press Ctrl-C to stop.");
  process.on("SIGINT", () => {
    err("");
    process.exit(0);
  });
  return await new Promise<never>(() => undefined); // serve until interrupted
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

/** 30m, 2h, 1d…; sub-second oddities keep their milliseconds. */
function formatInterval(ms: number): string {
  const units: Array<[number, string]> = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [size, suffix] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${suffix}`;
  }
  return `${ms}ms`;
}

function formatTaskLine(task: ScheduleTask, latestRun?: RunRecord, suffix = ""): string {
  const state = task.enabled ? "enabled" : "disabled";
  const schedule = task.schedule.kind === "interval"
    ? `every ${formatInterval(task.schedule.everyMs)}`
    : task.schedule.kind === "cron"
      ? `cron ${task.schedule.expression}`
      : `once ${task.schedule.runAt}`;
  const last = latestRun ? ` — last ${latestRun.status} at ${latestRun.finishedAt ?? latestRun.startedAt}` : "";
  return `${task.id} [${state}] ${task.name ?? "-"} — ${schedule} — next ${task.nextRunAt ?? "never"}${suffix}${last}`;
}

/** Verbose sibling of formatTaskLine: every scheduling fact, then the prompt. */
function formatTaskDetail(task: ScheduleTask): string {
  const lines = [
    `${task.id} [${task.enabled ? "enabled" : "disabled"}] ${task.name ?? "-"}`,
    `project: ${task.projectDir}`,
    `schedule: ${scheduleSummary(task)}`,
    `next run: ${task.nextRunAt ?? "never"}`,
  ];
  if (task.lastRunAt) {
    lines.push(`last run: ${task.lastRunAt}${task.lastStatus ? ` (${task.lastStatus})` : ""}`);
  }
  const counters = [
    task.successCount !== undefined ? `${task.successCount} success` : undefined,
    task.errorCount !== undefined ? `${task.errorCount} error` : undefined,
    task.missedCount !== undefined ? `${task.missedCount} missed` : undefined,
  ].filter(Boolean);
  if (counters.length > 0) lines.push(`runs: ${counters.join(", ")}`);
  if (task.agent) lines.push(`agent: ${task.agent}`);
  if (task.model) lines.push(`model: ${task.model}`);
  if (task.thinking) lines.push(`thinking: ${task.thinking}`);
  if (task.cwd) lines.push(`cwd: ${task.cwd}`);
  if (task.tools?.length) lines.push(`tools: ${task.tools.join(", ")}`);
  if (task.notify) lines.push(`notify: ${task.notify}`);
  if (task.notifyTo?.length) lines.push(`notify to: ${task.notifyTo.join(", ")}`);
  lines.push(`created: ${task.createdAt}  updated: ${task.updatedAt}`);
  lines.push("", "prompt:", task.prompt);
  return lines.join("\n");
}

function scheduleSummary(task: ScheduleTask): string {
  if (task.schedule.kind === "interval") return `every ${formatInterval(task.schedule.everyMs)}`;
  if (task.schedule.kind === "cron") {
    return `cron ${task.schedule.expression}${task.schedule.timezone ? ` (${task.schedule.timezone})` : ""}`;
  }
  return `once ${task.schedule.runAt}`;
}

type ParsedArgs = {
  command: string;
  project: string;
  /** True when --project was passed explicitly; commands like prune treat its absence as "all projects". */
  explicitProject: boolean;
  positional: string[];
  flags: Map<string, string | boolean>;
};

const BOOLEAN_FLAGS = new Set(["json", "all", "dry-run"]);

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  // `--help` anywhere on the line asks for usage, exactly like bare `help` —
  // checked up front because flag parsing would otherwise reject it.
  if (argv.includes("--help") || argv.includes("-h")) {
    return { command: "help", project: cwd, explicitProject: false, positional: [], flags: new Map() };
  }
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  let project = cwd;
  let explicitProject = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") {
      project = resolve(cwd, requireArgument(argv[++index], "--project requires a path"));
      explicitProject = true;
      continue;
    }
    if (token.startsWith("--project=")) {
      project = resolve(cwd, token.slice("--project=".length));
      explicitProject = true;
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
  return { command, project, explicitProject, positional: rest, flags };
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
