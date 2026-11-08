/**
 * The CLI surface, written for agents first (AXI): a machine reads these
 * lines, so every command answers "what happened" and "what next" in the same
 * shape, on the same stream, with the same exit codes.
 *
 *  0  success — data, or an explicit "nothing here" state
 *  1  ran, and the work failed (a Task Run errored)
 *  2  bad input — unknown flag, missing argument, no such task
 *  3  the machine is wrong — unreadable store, busy run lock, no terminal
 *
 * Errors are one line on stderr — `error: <code>: <message>` — never on
 * stdout, never blank, and never a guess at what the caller meant: an unknown
 * flag is refused, not silently ignored. Commands are actions plus
 * observations: a mutation prints the state it produced, then one `next:`
 * line naming a command that is valid from here.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./agents/builtin.ts";
import { UnknownAgentError } from "./agents/registry.ts";
import { PI_STORE_ENV } from "./agents/pi/adapter.ts";
import { migratePiSessions } from "./agents/pi/migrate.ts";
import type { AgentRegistry } from "./agents/registry.ts";
import { AppError, CliInputError, EnvironmentError } from "./errors.ts";
import { acquireLock } from "./lock.ts";
import { loadNotifyConfig, normalizeChannelIds } from "./notify/config.ts";
import { notifiersFor } from "./notify/dispatch.ts";
import type { ChannelId, RunNotification } from "./notify/types.ts";
import { schedulerPaths } from "./paths.ts";
import { loadRegistry } from "./registry.ts";
import { listRuns, listRunsForTask, pruneRuns } from "./runs.ts";
import { runDue, runTask, DEFAULT_KEEP_RUNS } from "./runner.ts";
import type { ScheduleInput } from "./scheduling.ts";
import { addTask, clearTasks, describeOverrides, exportTasks, importTasks, listTasks, removeTask, requireTask, setTaskEnabled, updateTask, type TaskPatch } from "./task-service.ts";
import { parseExportFile } from "./task-export.ts";
import type { RunRecord, ScheduleTask } from "./types.ts";

const BIN = "agents-cron";
/** List output is bounded by default; `--limit 0` (or `--full`) shows everything. */
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_RUNS_LIMIT = 10;

type Flags = Map<string, string | boolean>;
type Out = (line: string) => void;

const USAGE = [
  `${BIN} <command> [options]       bare ${BIN} prints tasks, like list`,
  "",
  "Read",
  "  list [--limit <n>] [--full] [--json]      Tasks: this project first, then others",
  "  show <taskId> [--json]                    One task: scheduling facts and its prompt",
  "  runs <taskId> [--limit <n>] [--json]      One task's runs, newest first",
  "  export [--out <file>] [--all] [taskId...] Task definitions as JSON (stdout, or --out)",
  "",
  "Schedule",
  "  add --prompt <text> (--at <iso>|--every <dur>|--cron <expr>) [options]",
  "  set <taskId> [options]        Reconfigure: --name --agent --model --thinking --cwd --tools --notify",
  "  enable <taskId> | disable <taskId> | remove <taskId> | clear",
  "  import <file> [--dry-run]     New tasks bind here and start disabled",
  "",
  "Run",
  "  run-due [--project <path>|--all] [--agent <id>]   Execute due tasks (cron entry point)",
  "  run <taskId> [--project <path>] [--agent <id>]    Execute one task now",
  "  prune [--keep <n>] [--project <path>]             Keep the newest n runs per task (default 20)",
  "  migrate-sessions [--dry-run] [--project <path>]   Carry legacy transcripts into Pi's session store",
  "",
  "Observe",
  "  dashboard [--port <n>]                          Read-only local view, foreground",
  "  dashboard start|stop|status [--port <n>]        Detached lifecycle",
  "  test-notify [--channel <id>]                    Send a test notification",
  "  setup-notify                                    Interactive channel wizard (needs a TTY)",
  "",
  "Global: --project <path> (default: current directory)  --json (machine-readable result)",
  `Agents: --agent <id> selects the adapter — built in: pi, claude, codex (default: pi)`,
  "add options: --name --agent --model --thinking --cwd --tools a,b --notify always|error|never --notify-to a,b",
  "set options: the same flags; an empty value clears the override — --model= --thinking= --tools=",
  "             thinking levels: off, minimal, low, medium, high, xhigh, max",
  "",
  "Exit codes: 0 success (empty results included), 1 a run failed, 2 bad input, 3 environment",
  "Errors: one line on stderr — error: <code>: <message>",
].join("\n");

/** Everything a command may be given; anything else is refused, not guessed at. */
const COMMAND_FLAGS: Record<string, readonly string[]> = {
  help: [],
  list: ["limit", "full", "json"],
  show: ["json"],
  runs: ["limit", "full", "json"],
  add: ["prompt", "at", "every", "cron", "timezone", "name", "agent", "model", "thinking", "cwd", "tools", "notify", "notify-to", "json"],
  set: ["name", "agent", "model", "thinking", "cwd", "tools", "notify", "notify-to", "json"],
  enable: ["json"],
  disable: ["json"],
  remove: ["json"],
  clear: ["json"],
  export: ["out", "all", "json"],
  import: ["dry-run", "json"],
  "run-due": ["all", "agent", "json"],
  run: ["agent", "json"],
  prune: ["keep", "json"],
  "migrate-sessions": ["dry-run"],
  dashboard: ["port", "json"],
  "test-notify": ["channel", "json"],
  "setup-notify": [],
};

/** How many positional arguments each command takes: `[min, max]`. */
const COMMAND_ARITY: Record<string, readonly [number, number]> = {
  help: [0, 0],
  list: [0, 0],
  show: [1, 1],
  runs: [1, 1],
  add: [0, 0],
  set: [1, 1],
  enable: [1, 1],
  disable: [1, 1],
  remove: [1, 1],
  clear: [0, 0],
  export: [0, Number.POSITIVE_INFINITY],
  import: [1, 1],
  "run-due": [0, 0],
  run: [1, 1],
  prune: [0, 0],
  "migrate-sessions": [0, 0],
  dashboard: [0, 1],
  "test-notify": [0, 0],
  "setup-notify": [0, 0],
};

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
    err(`${errorLine(error)}`);
    return exitCodeFor(error);
  }

  const { command, project, explicitProject, positional, flags } = parsed;
  try {
    validateInvocation(command, positional, flags);
    switch (command) {
      case "help":
        out(USAGE);
        return 0;
      case "run-due":
        return await commandRunDue(project, flags, deps, out);
      case "run":
        return await commandRun(project, flags, positional[0], deps, out);
      case "list":
        return await commandList(project, flags, out);
      case "show":
        return await commandShow(project, flags, positional[0], out);
      case "runs":
        return await commandRuns(project, flags, positional[0], out);
      case "add":
        return await commandAdd(project, flags, out);
      case "enable":
      case "disable":
        return await commandToggle(project, flags, positional[0], command === "enable", out);
      case "set":
        return await commandSet(project, flags, positional[0], out);
      case "remove":
        return await commandRemove(project, flags, positional[0], out);
      case "clear":
        return await commandClear(project, flags, out);
      case "export":
        return await commandExport(project, flags, positional, out);
      case "import":
        return await commandImport(project, flags, positional[0], out, err);
      case "prune":
        return await commandPrune(project, explicitProject, flags, out);
      case "dashboard":
        return await commandDashboard(project, positional, flags, out, err);
      case "migrate-sessions":
        return await commandMigrateSessions(project, explicitProject, flags, out, err);
      case "test-notify":
        return await commandTestNotify(project, flags, out, err);
      case "setup-notify":
        return commandSetupNotify(err);
      /* c8 ignore next 4 -- validateInvocation rejects unknown commands first */
      default:
        throw new CliInputError("unknown_command", `unknown command "${command}"; run ${BIN} help`);
    }
  } catch (error) {
    err(errorLine(error));
    return exitCodeFor(error);
  }
}

// --- the two shapes every command answers with -------------------------------

/** Prints the JSON form when --json is set, otherwise the lines, in order. */
function emit(out: Out, flags: Flags, json: unknown, lines: string[]): void {
  if (flags.has("json")) {
    out(JSON.stringify(json, null, 2));
    return;
  }
  for (const line of lines) out(line);
}

/** The last line of every successful command: something valid to run next. */
function next(...command: string[]): string {
  return `next: ${BIN} ${command.join(" ")}`;
}

async function commandRunDue(
  project: string,
  flags: Flags,
  deps: CliDeps,
  out: Out,
): Promise<number> {
  const result = await runDue({
    ...(!flags.has("all") ? { projectDir: project } : {}),
    agents: deps.agents,
    agent: stringFlag(flags, "agent"),
  });
  const json = { skipped: result.skipped, runs: result.runs, failures: result.failures, missed: result.missed };

  if (result.skipped) {
    emit(out, flags, json, ["Skipped: another agents-cron instance owns the run lock; nothing was attempted."]);
    return 0;
  }
  if (result.runs.length === 0) {
    emit(out, flags, json, ["No due tasks.", next("list", "--limit", "0")]);
    return 0;
  }

  const counts: Record<string, number> = {};
  for (const run of result.runs) counts[run.status] = (counts[run.status] ?? 0) + 1;
  const breakdown = Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  emit(out, flags, json, [
    ...result.runs.map((run) => `${run.status}: ${run.taskId} (${run.runId || "not started"})`),
    `ran ${result.runs.length}: ${breakdown}${result.missed ? `; ${result.missed} missed` : ""}`,
    next("list", "--limit", "0"),
  ]);
  return result.failures > 0 ? 1 : 0;
}

async function commandRun(
  project: string,
  flags: Flags,
  id: string,
  deps: CliDeps,
  out: Out,
): Promise<number> {
  const outcome = await runTask(project, id, {
    agents: deps.agents,
    agent: stringFlag(flags, "agent"),
  });
  const json = { runs: [outcome] };
  const detail = `${outcome.status}: ${outcome.taskId} (${outcome.runId || "not started"})${outcome.status === "skipped" ? " — another agents-cron instance owns the run lock" : ""}`;

  if (outcome.status === "error" || outcome.status === "missed") {
    emit(out, flags, json, [detail, `See why: ${BIN} runs ${outcome.taskId}`]);
    return 1;
  }
  emit(out, flags, json, [detail, next("runs", outcome.taskId)]);
  return 0;
}

async function commandList(project: string, flags: Flags, out: Out): Promise<number> {
  const tasks = await listTasks(project);
  if (flags.has("json")) {
    out(JSON.stringify(tasks, null, 2));
    return 0;
  }
  if (tasks.length === 0) {
    out("No scheduled tasks here or in any other project.");
    out(next("add", '--prompt "..."', "--every 1h"));
    return 0;
  }

  // One ordered list: the current project's tasks plain, then every other
  // project under a header. Ambiguous basenames fall back to full paths.
  const local = resolve(project);
  const limit = resolveLimit(flags, DEFAULT_LIST_LIMIT);
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

  // The limit applies per project block, so a busy other project cannot push
  // this project's tasks out of view.
  const seen = new Map<string, number>();
  let previous: string | undefined;
  let hidden = 0;
  for (const task of tasks) {
    if (task.projectDir !== local && task.projectDir !== previous) {
      const label = basenames.get(basename(task.projectDir))! > 1 ? task.projectDir : basename(task.projectDir);
      const missing = existsSync(task.projectDir) ? "" : " ⚠ missing directory";
      out("");
      out(`${label}${missing} — ${task.projectDir}`);
      previous = task.projectDir;
    }
    const shown = (seen.get(task.projectDir) ?? 0) + 1;
    seen.set(task.projectDir, shown);
    if (limit > 0 && shown > limit) {
      hidden += 1;
      continue;
    }
    const latest = latestByProject.get(task.projectDir)!.find((run) => run.taskId === task.id);
    const missing = existsSync(task.projectDir) ? "" : " ⚠ missing directory";
    out(formatTaskLine(task, latest, missing));
  }
  const hereCount = tasks.filter((task) => task.projectDir === local).length;
  const otherProjects = new Set(tasks.filter((task) => task.projectDir !== local).map((task) => task.projectDir)).size;
  out("");
  out(
    `tasks: ${tasks.length} total — ${hereCount} here` +
      (otherProjects ? `, ${tasks.length - hereCount} in ${otherProjects} other project(s)` : ""),
  );
  if (hidden > 0) out(`… ${hidden} task(s) hidden by --limit ${limit} — add --limit 0 to see all`);
  out(next("show", tasks[0].id));
  return 0;
}

/** One task in full: scheduling facts first, then the prompt verbatim. */
async function commandShow(project: string, flags: Flags, id: string, out: Out): Promise<number> {
  const task = requireTask(await listTasks(project), id);
  if (flags.has("json")) {
    out(JSON.stringify(task, null, 2));
    return 0;
  }
  out(formatTaskDetail(task));
  out(next("runs", task.id));
  return 0;
}

/** One task's run history, newest first — the observation `run` and `run-due` point at. */
async function commandRuns(project: string, flags: Flags, id: string, out: Out): Promise<number> {
  const task = requireTask(await listTasks(project), id);
  const runs = await listRunsForTask(schedulerPaths(task.projectDir).runsDir, task.id);
  if (flags.has("json")) {
    out(JSON.stringify(runs, null, 2));
    return 0;
  }
  if (runs.length === 0) {
    out(`No runs for ${task.id} yet.`);
    out(next("run", task.id));
    return 0;
  }

  const limit = resolveLimit(flags, DEFAULT_RUNS_LIMIT);
  const shown = limit > 0 ? runs.slice(0, limit) : runs;
  const full = flags.has("full");
  for (const run of shown) {
    const when = stamp(run.finishedAt ?? run.startedAt);
    const parts = [`${run.runId} [${run.status}] ${run.trigger} — ${when}`];
    if (run.error) parts.push(`— ${firstLine(run.error)}`);
    if (full && run.summary) parts.push(`\n  ${firstLine(run.summary)}`);
    if (full && run.sessionFile) parts.push(`\n  session: ${run.sessionFile}`);
    out(parts.join(" "));
  }
  const hidden = runs.length - shown.length;
  if (hidden > 0) out(`… ${hidden} older run(s) hidden (--limit 0 for all)`);

  const counts: Record<string, number> = {};
  for (const run of runs) counts[run.status] = (counts[run.status] ?? 0) + 1;
  out(`runs: ${runs.length} total — ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ")}`);
  out(next("show", task.id));
  return 0;
}

async function commandAdd(project: string, flags: Flags, out: Out): Promise<number> {
  const prompt = requireFlag(flags, "prompt", "add requires --prompt <text>");
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
  await warnUnknownAgent(task.agent);
  emit(out, flags, { created: task }, [
    `Created ${task.id}`,
    formatTaskLine(task),
    next("run", task.id),
  ]);
  return 0;
}

async function commandToggle(
  project: string,
  flags: Flags,
  id: string,
  enabled: boolean,
  out: Out,
): Promise<number> {
  const task = await setTaskEnabled(project, id, enabled);
  emit(out, flags, { updated: task }, [
    `${enabled ? "Enabled" : "Disabled"} ${task.id}`,
    formatTaskLine(task),
    next(enabled ? "disable" : "enable", task.id),
  ]);
  return 0;
}

/** One line per flag value, comma-separated and blanks dropped. */
function commaList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Reads a TaskPatch out of parsed flags. Present flag means apply; an empty
 * value (`--model=`, `--tools=`, `--notify=`) means clear the override back
 * to the project and user defaults.
 */
function patchFromFlags(flags: Flags): TaskPatch {
  const patch: TaskPatch = {};
  for (const field of ["name", "agent", "model", "thinking", "cwd"] as const) {
    if (flags.has(field)) patch[field] = stringFlag(flags, field) ?? "";
  }
  if (flags.has("tools")) patch.tools = commaList(stringFlag(flags, "tools"));
  if (flags.has("notify-to")) patch.notifyTo = commaList(stringFlag(flags, "notify-to"));
  if (flags.has("notify")) {
    const value = stringFlag(flags, "notify") ?? "";
    if (value && value !== "always" && value !== "error" && value !== "never") {
      throw new CliInputError("bad_value", `--notify must be one of: always, error, never — got '${value}'`);
    }
    patch.notify = value as TaskPatch["notify"];
  }
  return patch;
}

/** Reconfigures one task and reports what it now pins. */
async function commandSet(project: string, flags: Flags, id: string, out: Out): Promise<number> {
  const task = await updateTask(project, id, patchFromFlags(flags));
  await warnUnknownAgent(task.agent);
  const overrides = describeOverrides(task);
  emit(out, flags, { updated: task }, [
    `Updated ${task.id}${overrides.length ? ` — ${overrides.join("; ")}` : " — no overrides; runs use the project and user defaults"}`,
    formatTaskLine(task),
    next("show", task.id),
  ]);
  return 0;
}

async function commandRemove(project: string, flags: Flags, id: string, out: Out): Promise<number> {
  const task = requireTask(await listTasks(project), id);
  await removeTask(project, task.id);
  const left = (await listTasks(project)).filter((entry) => entry.projectDir === task.projectDir).length;
  emit(out, flags, { removed: task, remaining: left }, [
    `Removed ${task.id}${task.name ? ` (${task.name})` : ""}; ${left} task(s) left in ${task.projectDir}`,
    next("list"),
  ]);
  return 0;
}

async function commandClear(project: string, flags: Flags, out: Out): Promise<number> {
  const removed = await clearTasks(project);
  // Nothing to do is a state, not a failure — but it is not silent either.
  emit(out, flags, { removed, projectDir: resolve(project) }, [
    removed === 0
      ? `No tasks bound to ${resolve(project)}; nothing to clear.`
      : `Cleared ${removed} task(s) bound to ${resolve(project)}.`,
    next("list"),
  ]);
  return 0;
}

/** Writes a Task Export: definitions only — stdout by default, a file with --out. */
async function commandExport(
  project: string,
  flags: Flags,
  positional: string[],
  out: Out,
): Promise<number> {
  if (flags.has("all") && positional.length > 0) {
    throw new CliInputError("usage", "export: pass either --all or task ids, not both");
  }
  const file = await exportTasks(project, {
    ...(positional.length ? { ids: positional } : {}),
    ...(flags.has("all") ? { all: true } : {}),
  });
  const json = JSON.stringify(file, null, 2);

  const target = stringFlag(flags, "out");
  if (target === undefined) {
    // stdout is the file: no commentary may share the pipe.
    out(json);
    return 0;
  }
  const destination = resolve(process.cwd(), target);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${json}\n`, "utf8");
  emit(out, flags, { wrote: file.tasks.length, path: destination }, [
    `Wrote ${file.tasks.length} task(s) to ${target}`,
    next("import", target),
  ]);
  return 0;
}

/** Reads a Task Export and creates its definitions here, disabled by default. */
async function commandImport(
  project: string,
  flags: Flags,
  file: string,
  out: Out,
  err: Out,
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(resolve(process.cwd(), file), "utf8");
  } catch (error) {
    throw new CliInputError("unreadable_file", `cannot read task export ${file}: ${(error as Error).message}`);
  }
  const parsed = parseExportFile(raw);
  const dryRun = flags.has("dry-run");
  const report = await importTasks(project, parsed.tasks, { dryRun });

  const verb = dryRun ? "Would import" : "Imported";
  const lines = [`${verb} ${report.created.length} task(s) into ${project}; all start disabled`];
  for (const task of report.created) {
    const label = task.name ?? previewPrompt(task.prompt);
    lines.push(`  ${dryRun ? `would create ${label}` : `created ${task.id} — ${label}`}`);
  }
  for (const skip of report.skipped) {
    lines.push(`  skipped "${skip.entry.name ?? previewPrompt(skip.entry.prompt)}" — ${skip.reason}`);
  }
  if (parsed.tasks.length === 0) lines.push("  (the file contains no tasks)");
  if (report.created.length > 0 && !dryRun) lines.push(next("enable", report.created[0].id));
  else if (report.created.length > 0) lines.push(next("import", file));

  emit(out, flags, { dryRun, created: report.created, skipped: report.skipped }, lines);
  for (const warning of report.warnings) err(`Warning: ${warning}`);
  return 0;
}

function previewPrompt(prompt: string): string {
  return prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;
}

/**
 * Spawns the interactive notification wizard. It drives a real terminal
 * (menus, hidden secret entry, browser opening), so it refuses to run when
 * stdout is not a TTY instead of half-working.
 */
function commandSetupNotify(err: Out): number {
  if (!process.stdout.isTTY) {
    err(errorLine(new EnvironmentError("no_tty", `setup-notify is interactive — run it in a terminal, or test an existing setup with: ${BIN} test-notify`)));
    return 3;
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "setup-notify.sh");
  if (!existsSync(script)) {
    err(errorLine(new EnvironmentError("missing_script", `setup wizard not found: ${script} — reinstall ${BIN}`)));
    return 3;
  }
  const result = spawnSync("bash", [script], { stdio: "inherit" });
  return result.status ?? 1;
}

function notifyFlag(flags: Flags): "always" | "error" | "never" | undefined {
  const value = stringFlag(flags, "notify");
  if (value === undefined) return undefined;
  if (value === "always" || value === "error" || value === "never") return value;
  throw new CliInputError("bad_value", `--notify must be one of: always, error, never — got '${value}'`);
}

/** --notify-to a,b — comma-separated channel ids; empty means "no routing". */
function notifyToFlag(flags: Flags): ChannelId[] | undefined {
  const value = stringFlag(flags, "notify-to");
  if (value === undefined) return undefined;
  return normalizeChannelIds(value.split(","));
}

/** Sends a synthetic notification through every configured channel (or one). */
async function commandTestNotify(project: string, flags: Flags, out: Out, err: Out): Promise<number> {
  const paths = schedulerPaths(project);
  const config = await loadNotifyConfig(paths.dir);
  if (config.channels.length === 0) {
    const message = `no notification channels configured in ${join(paths.dir, "config.json")}`;
    err(errorLine(new EnvironmentError("no_channels", `${message}; run ${BIN} setup-notify or add a "system" channel`)));
    return 3;
  }

  const only = stringFlag(flags, "channel");
  const channels = only ? config.channels.filter((channel) => channel.id === only) : config.channels;
  if (channels.length === 0) {
    const known = config.channels.map((channel) => channel.id).join(", ");
    err(errorLine(new CliInputError("unknown_channel", `no channel named "${only}" in ${join(paths.dir, "config.json")}; configured: ${known}`)));
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
        err(errorLine(new AppError(`${notifier.id}: ${reason}`, "notify_failed", 1)));
      }
    }),
  );
  const delivered = channels.length - failed.length;
  emit(out, flags, { delivered, failed }, [
    `channels: ${delivered} delivered, ${failed.length} failed`,
    failed.length ? next("test-notify", "--channel", failed[0]) : next("list"),
  ]);
  return failed.length > 0 ? 1 : 0;
}

async function commandPrune(
  project: string,
  explicitProject: boolean,
  flags: Flags,
  out: Out,
): Promise<number> {
  const raw = stringFlag(flags, "keep");
  const keep = raw === undefined ? DEFAULT_KEEP_RUNS : Number(raw);
  if (!Number.isInteger(keep) || keep < 0) {
    throw new CliInputError("bad_value", `--keep must be a non-negative integer, got '${raw}'`);
  }
  const projectDirs = explicitProject
    ? [project]
    : [...new Set((await loadRegistry()).map((task) => task.projectDir))];
  let pruned = 0;
  for (const dir of projectDirs) {
    const paths = schedulerPaths(dir);
    pruned += await pruneRuns(paths.runsDir, paths.reportsDir, keep);
  }
  emit(out, flags, { pruned, keep, projects: projectDirs.length }, [
    pruned === 0
      ? `Pruned 0 run(s); nothing beyond ${keep} per task in ${projectDirs.length} project(s).`
      : `Pruned ${pruned} run(s); kept the newest ${keep} per task in ${projectDirs.length} project(s).`,
    next("list", "--limit", "0"),
  ]);
  return 0;
}

/**
 * Carries legacy private-layout Task Session transcripts into Pi's default
 * session store and rewrites run records to match. Mutates each project's
 * store, so it takes that project's run lock; refuses (exit 3) while another
 * instance owns it. Without an explicit --project it covers every project in
 * the registry, like prune.
 */
async function commandMigrateSessions(
  project: string,
  explicitProject: boolean,
  flags: Flags,
  out: Out,
  err: Out,
): Promise<number> {
  const dryRun = flags.has("dry-run");
  const projectDirs = explicitProject
    ? [project]
    : [...new Set((await loadRegistry()).map((task) => task.projectDir))];

  if (projectDirs.length === 0) {
    out("Nothing to migrate: no projects in the registry.");
    out(next("list"));
    return 0;
  }

  let exit = 0;
  const moved: unknown[] = [];
  for (const dir of projectDirs) {
    const paths = schedulerPaths(dir);
    const lock = await acquireLock(paths.lockFile);
    if (!lock) {
      err(errorLine(new EnvironmentError("lock_busy", `another agents-cron instance holds ${dir}'s run lock; migrate-sessions refused`)));
      exit = 3;
      continue;
    }
    try {
      const report = await migratePiSessions({ projectDir: dir, dryRun });
      moved.push(report);
      printMigrationReport(report, dir, projectDirs.length > 1, dryRun, out);
    } finally {
      await lock.release();
    }
  }
  if (moved.length > 0) out(dryRun ? next("migrate-sessions") : next("list"));
  return exit;
}

function printMigrationReport(
  report: ReturnType<typeof migratePiSessions> extends Promise<infer R> ? R : never,
  projectDir: string,
  grouped: boolean,
  dryRun: boolean,
  out: Out,
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
 * The dashboard's two lives. Bare `dashboard` serves in the foreground until
 * interrupted; `start`, `stop`, and `status` manage a detached instance
 * through the project's registration file. The server is localhost only and
 * mutates nothing, so it never touches the run lock.
 */
async function commandDashboard(
  project: string,
  positional: string[],
  flags: Flags,
  out: Out,
  err: Out,
): Promise<number> {
  const { startDashboard, DEFAULT_DASHBOARD_PORT } = await import("./dashboard/server.ts");
  const {
    dashboardStatus,
    logFile,
    refusalMessage,
    removeDashboardState,
    startDetachedDashboard,
    stopDashboard,
    writeDashboardState,
  } = await import("./dashboard/lifecycle.ts");

  const subcommand = positional[0];
  if (subcommand === "start") {
    const state = (await startDetachedDashboard(project, parsePort(flags, 0))).state;
    emit(out, flags, state, [
      `Dashboard ${state.url} (pid ${state.pid})`,
      `logs: ${logFile(project)}`,
      next("dashboard", "status"),
    ]);
    return 0;
  }
  if (subcommand === "stop") {
    const result = await stopDashboard(project);
    if (result.outcome === "refused" && result.state) {
      err(refusalMessage(result.state, result.process));
      return 1;
    }
    emit(out, flags, { outcome: result.outcome }, [
      result.outcome === "stopped"
        ? `Stopped dashboard (pid ${result.state?.pid})`
        : result.outcome === "stale"
          ? "Removed stale dashboard state; nothing was serving."
          : "No dashboard running; nothing to stop.",
      next("dashboard", "start"),
    ]);
    return 0;
  }
  if (subcommand === "status") {
    const status = await dashboardStatus(project);
    if (!status.running) {
      emit(out, flags, { running: false, stale: status.stale }, [
        `Not running${status.stale ? " (removed stale state)" : ""}`,
        next("dashboard", "start"),
      ]);
      return 0;
    }
    const health = status.healthy ? "" : ", not responding — likely wedged";
    emit(out, flags, status, [
      `Running: ${status.state.url} (pid ${status.state.pid}, since ${status.state.startedAt})${health}`,
      next("dashboard", "stop"),
    ]);
    return 0;
  }
  if (subcommand !== undefined) {
    throw new CliInputError("usage", `dashboard: unknown subcommand "${subcommand}"; use start, stop, or status`);
  }

  const port = parsePort(flags, DEFAULT_DASHBOARD_PORT);
  let handle: Awaited<ReturnType<typeof startDashboard>>;
  try {
    handle = await startDashboard({ projectDir: project, port });
  } catch (error) {
    // A second foreground dashboard usually means one is already serving this
    // project; point at it instead of only reporting EADDRINUSE.
    const status = await dashboardStatus(project);
    if (status.running && status.healthy) {
      err(`A dashboard for this project is already running: ${status.state.url} — stop it with: ${BIN} dashboard stop`);
    }
    throw error;
  }

  await writeDashboardState(project, {
    pid: process.pid,
    port: Number(new URL(handle.url).port),
    url: handle.url,
    startedAt: new Date().toISOString(),
  });
  out(`${BIN} dashboard: ${handle.url}`);
  out("Read-only view of tasks and runs. Press Ctrl-C to stop.");

  // Owning the registration means clearing it on the way out, whenever that is.
  const shutdown = (): void => {
    void removeDashboardState(project, process.pid).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => {
    err("");
    shutdown();
  });
  process.on("SIGTERM", shutdown);
  return await new Promise<never>(() => undefined); // serve until interrupted
}

/** --port, validated; a missing flag takes the caller's default. */
function parsePort(flags: Flags, fallback: number): number {
  const raw = stringFlag(flags, "port");
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliInputError("bad_value", `--port must be an integer between 0 and 65535, got '${raw}'`);
  }
  return port;
}

function scheduleFromFlags(flags: Flags): ScheduleInput {
  const at = stringFlag(flags, "at");
  const every = stringFlag(flags, "every");
  const cron = stringFlag(flags, "cron");
  const chosen = [at, every, cron].filter(Boolean).length;
  if (chosen !== 1) {
    throw new CliInputError(
      "usage",
      `add requires exactly one of --at, --every, or --cron (got ${chosen}) — e.g. --every 45m, --at 2026-10-29T09:00:00Z, or --cron "0 9 * * 1"`,
    );
  }
  if (at) return { kind: "once", runAt: at };
  if (every) {
    if (flags.has("timezone")) {
      throw new CliInputError("usage", "--timezone only applies to --cron; --every is a plain interval");
    }
    return { kind: "interval", every };
  }
  return { kind: "cron", expression: cron!, timezone: stringFlag(flags, "timezone") };
}

// --- formatting -------------------------------------------------------------

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

/** Compact ISO 8601: whole seconds drop the `.000`, so lines stay scannable and diffable. */
function stamp(iso?: string): string {
  return iso === undefined ? "never" : iso.replace(/\.000Z$/, "Z");
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function formatTaskLine(task: ScheduleTask, latestRun?: RunRecord, suffix = ""): string {
  const state = task.enabled ? "enabled" : "disabled";
  const last = latestRun
    ? ` — last ${latestRun.status} at ${stamp(latestRun.finishedAt ?? latestRun.startedAt)}`
    : " — never run";
  return `${task.id} [${state}] ${task.name ?? "-"} — ${scheduleSummary(task)}${suffix} — next ${stamp(task.nextRunAt)}${last}`;
}

/** Verbose sibling of formatTaskLine: every scheduling fact, then the prompt. */
function formatTaskDetail(task: ScheduleTask): string {
  const lines = [
    `${task.id} [${task.enabled ? "enabled" : "disabled"}] ${task.name ?? "-"}`,
    `project: ${task.projectDir}`,
    `schedule: ${scheduleSummary(task)}`,
    `next run: ${stamp(task.nextRunAt)}`,
  ];
  if (task.lastRunAt) {
    lines.push(`last run: ${stamp(task.lastRunAt)}${task.lastStatus ? ` (${task.lastStatus})` : ""}`);
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
  lines.push(`created: ${stamp(task.createdAt)}  updated: ${stamp(task.updatedAt)}`);
  lines.push("", "prompt:", task.prompt);
  return lines.join("\n");
}

function scheduleSummary(task: ScheduleTask): string {
  if (task.schedule.kind === "interval") return `every ${formatInterval(task.schedule.everyMs)}`;
  if (task.schedule.kind === "cron") {
    return `cron ${task.schedule.expression}${task.schedule.timezone ? ` (${task.schedule.timezone})` : ""}`;
  }
  return `once ${stamp(task.schedule.runAt)}`;
}

/** Names an agent id that would fail at 3 a.m. instead of now. */
async function warnUnknownAgent(agent: string | undefined): Promise<void> {
  if (!agent) return;
  const { listAgents } = await import("./agents/registry.ts");
  const known = listAgents().map((info) => info.id);
  if (known.length > 0 && !known.includes(agent) && agent !== "fake") {
    process.stderr.write(`Warning: no agent adapter named "${agent}" is registered (known: ${known.join(", ")}); runs will fail until one is.\n`);
  }
}

// --- argument parsing -------------------------------------------------------

type ParsedArgs = {
  command: string;
  project: string;
  /** True when --project was passed explicitly; commands like prune treat its absence as "all projects". */
  explicitProject: boolean;
  positional: string[];
  flags: Flags;
};

const BOOLEAN_FLAGS = new Set(["json", "all", "dry-run", "full"]);

/** Every flag any command accepts — a name outside this set is refused at parse time. */
const ALL_FLAGS = new Set<string>([
  "project",
  ...Object.values(COMMAND_FLAGS).flat(),
]);

function parseArgs(argv: string[], cwd: string): ParsedArgs {
  // `--help` anywhere on the line asks for usage, exactly like bare `help` —
  // checked up front because flag validation would otherwise reject it.
  if (argv.includes("--help") || argv.includes("-h")) {
    return { command: "help", project: cwd, explicitProject: false, positional: [], flags: new Map() };
  }
  const positional: string[] = [];
  const flags: Flags = new Map();
  let project = cwd;
  let explicitProject = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") {
      project = resolve(cwd, requireValue(argv[++index], "--project requires a path"));
      explicitProject = true;
      continue;
    }
    if (token.startsWith("--project=")) {
      project = resolve(cwd, requireValue(token.slice("--project=".length), "--project requires a path"));
      explicitProject = true;
      continue;
    }
    if (token.startsWith("--")) {
      const [name, inlineValue] = splitFlag(token);
      if (!ALL_FLAGS.has(name)) {
        throw new CliInputError("unknown_flag", `no command accepts --${name}; run ${BIN} help`);
      }
      if (BOOLEAN_FLAGS.has(name)) {
        if (inlineValue !== undefined) {
          throw new CliInputError("usage", `--${name} takes no value, got '--${name}=${inlineValue}'`);
        }
        flags.set(name, true);
        continue;
      }
      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliInputError("usage", `--${name} requires a value; write --${name} <value> or --${name}=<value>`);
      }
      flags.set(name, value);
      index += 1;
      continue;
    }
    positional.push(token);
  }

  // Bare invocation is the question agents ask most: "what is scheduled here?"
  const [command = "list", ...rest] = positional;
  return { command, project, explicitProject, positional: rest, flags };
}

/** Refuses what the command does not understand instead of quietly ignoring it. */
function validateInvocation(command: string, positional: string[], flags: Flags): void {
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) {
    throw new CliInputError("unknown_command", `unknown command "${command}"; run ${BIN} help for the list`);
  }
  const known = ["project", ...allowed];
  for (const name of flags.keys()) {
    if (known.includes(name)) continue;
    throw new CliInputError(
      "unknown_flag",
      `${command}: unknown flag --${name}; accepted: ${known.map((flag) => `--${flag}`).join(", ")} (${BIN} help)`,
    );
  }
  const [min, max] = COMMAND_ARITY[command];
  if (positional.length < min || positional.length > max) {
    const wanted = min === max ? `${min}` : max === Number.POSITIVE_INFINITY ? `at least ${min}` : `${min}–${max}`;
    throw new CliInputError(
      "usage",
      `${command}: takes ${wanted} positional argument(s), got ${positional.length}${positional.length ? ` (${positional.join(" ")})` : ""}; ${BIN} help`,
    );
  }
  // Combinations that would silently cancel each other are refused here, once,
  // instead of inside each command after half of it already ran.
  const limit = stringFlag(flags, "limit");
  if (flags.has("json") && (flags.has("full") || limit !== undefined)) {
    throw new CliInputError("usage", `${command} --json returns every record in full; drop --limit/--full and filter the JSON instead`);
  }
  if (flags.has("full") && limit !== undefined && Number(limit) !== 0) {
    throw new CliInputError("usage", `--full shows everything; drop --limit ${limit} (or drop --full)`);
  }
}

function splitFlag(token: string): [string, string | undefined] {
  const body = token.slice(2);
  const equals = body.indexOf("=");
  return equals >= 0 ? [body.slice(0, equals), body.slice(equals + 1)] : [body, undefined];
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function requireFlag(flags: Flags, name: string, message: string): string {
  return requireValue(stringFlag(flags, name), message);
}

function requireValue(value: string | undefined, message: string): string {
  if (!value) throw new CliInputError("usage", message);
  return value;
}

/** `--limit n`: 0 (or --full) means everything; anything else must be a non-negative integer. */
function resolveLimit(flags: Flags, fallback: number): number {
  const raw = stringFlag(flags, "limit");
  if (raw === undefined) return flags.has("full") ? 0 : fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new CliInputError("bad_value", `--limit must be a non-negative integer, got '${raw}' (0 shows everything)`);
  }
  return flags.has("full") ? 0 : limit;
}

// --- errors -----------------------------------------------------------------

/** `error: <code>: <message>` — one line, stderr only, code machine-readable. */
function errorLine(error: unknown): string {
  if (error instanceof AppError) return `error: ${error.code}: ${error.message}`;
  if (error instanceof UnknownAgentError) return `error: unknown_agent: ${error.message}`;
  if (error instanceof Error) return `error: input: ${error.message}`;
  return `error: internal: ${String(error)}`;
}

function exitCodeFor(error: unknown): number {
  if (error instanceof AppError) return error.exitCode;
  // Anything else is a validation message this codebase throws as a plain
  // Error (duration, cron, thinking level…): the caller's input was wrong.
  return 2;
}
