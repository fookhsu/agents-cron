import test, { before, beforeEach, after } from "node:test";

// Every test runs against a throwaway Task Registry.
let restoreHome: (() => void) | undefined;
before(async () => {
  const home = await mkdtemp(join(tmpdir(), "agents-cron-home-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  restoreHome = () => {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
  };
});
after(() => restoreHome?.());

beforeEach(async () => {
  const { saveRegistry } = await import("../src/registry.ts");
  await saveRegistry([]);
});
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentRegistry } from "../src/agents/registry.ts";
import type { AgentAdapter, AgentRunResult } from "../src/agents/types.ts";
import { main, type CliDeps } from "../src/cli.ts";
import { dashboardStateFile } from "../src/dashboard/lifecycle.ts";
import { acquireLock } from "../src/lock.ts";
import { schedulerPaths } from "../src/paths.ts";
import { listRuns, writeRun } from "../src/runs.ts";
import type { RunRecord } from "../src/types.ts";

class FakeAgent implements AgentAdapter {
  readonly id = "fake";
  readonly displayName = "Fake";
  calls = 0;
  fail = false;
  requested: Array<string | undefined> = [];

  async run(): Promise<AgentRunResult> {
    this.calls += 1;
    if (this.fail) throw new Error("provider unavailable");
    return { sessionFile: "/tmp/session.jsonl", summary: "done" };
  }
}

function registryFor(agent: FakeAgent): AgentRegistry {
  return {
    resolve: async (id) => {
      agent.requested.push(id);
      return agent;
    },
    list: () => [{ id: agent.id, displayName: agent.displayName }],
  };
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agents-cron-cli-"));
}

function capture(projectDir: string, agent: FakeAgent): { deps: CliDeps; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    deps: {
      cwd: projectDir,
      agents: registryFor(agent),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

test("unknown commands are refused as bad input, one machine-readable line", async () => {
  const dir = await project();
  const { deps, stderr, stdout } = capture(dir, new FakeAgent());
  assert.equal(await main(["frobnicate"], deps), 2);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join("\n"), /^error: unknown_command: unknown command "frobnicate"/);
});

test("lists an empty project without failing", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  assert.equal(await main(["list"], deps), 0);
  assert.match(stdout.join("\n"), /No scheduled tasks/);
});

test("add without a schedule flag teaches the three forms", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  assert.equal(await main(["add", "--prompt", "x"], deps), 2);
  const text = stderr.join("\n");
  assert.match(text, /--every 45m/);
  assert.match(text, /--cron "0 9 \* \* 1"/);
});

test("adds a task and lists it as JSON", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  assert.equal(await main(["add", "--prompt", "Check CI", "--every", "30m", "--name", "ci"], deps), 0);
  assert.match(stdout.join("\n"), /Created task_/);

  stdout.length = 0;
  assert.equal(await main(["list", "--json"], deps), 0);
  const tasks = JSON.parse(stdout.join("\n"));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, "ci");
  assert.equal(tasks[0].schedule.kind, "interval");
});

test("commands run from the registry's own home dir leave the registry alone", async () => {
  // `$HOME/.agents/cron/tasks.json` is the global registry, but it is also
  // the legacy-store path of a project rooted at $HOME; the lazy import must
  // not mistake one for the other.
  const home = process.env.AGENTS_CRON_HOME!;
  const { deps, stdout, stderr } = capture(home, new FakeAgent());

  assert.equal(await main(["list"], deps), 0);
  assert.match(stdout.join("\n"), /No scheduled tasks/);

  assert.equal(await main(["add", "--prompt", "home duty", "--every", "30m"], deps), 0);
  const id = /Created (task_[^\s;]+)/.exec(stdout.join("\n"))![1];
  stdout.length = 0;
  assert.equal(await main(["show", id], deps), 0); // no format error, no import
  assert.match(stdout.join("\n"), /prompt:\nhome duty/);
});

test("show prints one task's scheduling facts and prompt", async () => {
  const dir = await project();
  const { deps, stdout, stderr } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m", "--name", "ci"], deps);
  const id = /Created (task_[^\s;]+)/.exec(stdout.join("\n"))![1];

  stdout.length = 0;
  assert.equal(await main(["show", id.slice(0, 9)], deps), 0); // id prefix resolves
  const text = stdout.join("\n");
  assert.match(text, new RegExp(`${id} \\[enabled\\] ci`));
  assert.match(text, /schedule: every 30m/);
  assert.match(text, new RegExp(`project: ${dir.replace(/\//g, "\\/")}`));
  assert.match(text, /prompt:\nCheck CI/);

  stdout.length = 0;
  assert.equal(await main(["show", "--json", id], deps), 0);
  assert.equal(JSON.parse(stdout.join("\n")).prompt, "Check CI");

  assert.equal(await main(["show", "task_missing"], deps), 2);
  assert.match(stderr.join("\n"), /Task not found: task_missing/);
});

test("add --agent records the agent on the task", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m", "--agent", "codex"], deps);

  stdout.length = 0;
  await main(["list", "--json"], deps);
  const [task] = JSON.parse(stdout.join("\n"));
  assert.equal(task.agent, "codex");
});

test("set reconfigures a task's model and thinking after creation", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m"], deps);
  const id = /Created (task_[^\s;]+)/.exec(stdout.join("\n"))![1];

  stdout.length = 0;
  assert.equal(await main(["set", id, "--model", "anthropic/claude-opus-4-5", "--thinking", "high"], deps), 0);
  assert.match(stdout.join("\n"), new RegExp(`Updated ${id}`));
  assert.match(stdout.join("\n"), /model: anthropic\/claude-opus-4-5/);
  assert.match(stdout.join("\n"), /thinking: high/);

  stdout.length = 0;
  await main(["show", id], deps);
  const text = stdout.join("\n");
  assert.match(text, /model: anthropic\/claude-opus-4-5/);
  assert.match(text, /thinking: high/);
});

test("set with empty flag values clears overrides back to the defaults", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m", "--model", "haiku", "--thinking", "low", "--tools", "read"], deps);
  const id = /Created (task_[^\s;]+)/.exec(stdout.join("\n"))![1];

  stdout.length = 0;
  assert.equal(await main(["set", id, "--model=", "--thinking=", "--tools="], deps), 0);
  assert.match(stdout.join("\n"), /no overrides/);

  stdout.length = 0;
  await main(["show", id, "--json"], deps);
  const task = JSON.parse(stdout.join("\n"));
  assert.equal("model" in task, false);
  assert.equal("thinking" in task, false);
  assert.equal("tools" in task, false);
});

test("set validates its input: bad thinking, no flags, unknown id", async () => {
  const dir = await project();
  const { deps, stdout, stderr } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m"], deps);
  const id = /Created (task_[^\s;]+)/.exec(stdout.join("\n"))![1];

  assert.equal(await main(["set", id, "--thinking", "sideways"], deps), 2);
  assert.match(stderr.join("\n"), /--thinking must be one of: off, minimal, low, medium, high, xhigh, max/);

  assert.equal(await main(["set", id], deps), 2);
  assert.match(stderr.join("\n"), /set requires at least one of/);

  assert.equal(await main(["set", "task_nope", "--model", "haiku"], deps), 2);
  assert.match(stderr.join("\n"), /Task not found/);
});

test("add rejects an invalid --thinking level up front", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  assert.equal(await main(["add", "--prompt", "x", "--every", "30m", "--thinking", "deep"], deps), 2);
  assert.match(stderr.join("\n"), /--thinking must be one of/);
});

test("run-due executes a due task and records a run", async () => {
  const dir = await project();
  const agent = new FakeAgent();
  const { deps } = capture(dir, agent);
  await main(["add", "--prompt", "Check CI", "--at", new Date().toISOString()], deps);

  assert.equal(await main(["run-due"], deps), 0);
  assert.equal(agent.calls, 1);
  const [run] = await listRuns(schedulerPaths(dir).runsDir);
  assert.equal(run.status, "success");
  assert.equal(run.trigger, "scheduled");
  assert.equal(run.agent, "fake");
});

test("run-due --agent overrides tasks that name no agent", async () => {
  const dir = await project();
  const agent = new FakeAgent();
  const { deps } = capture(dir, agent);
  await main(["add", "--prompt", "Check CI", "--at", new Date().toISOString()], deps);

  assert.equal(await main(["run-due", "--agent", "codex"], deps), 0);
  assert.deepEqual(agent.requested, ["codex"]);
});

test("run-due exits 1 when a task fails", async () => {
  const dir = await project();
  const agent = new FakeAgent();
  agent.fail = true;
  const { deps } = capture(dir, agent);
  await main(["add", "--prompt", "Check CI", "--at", new Date().toISOString()], deps);

  assert.equal(await main(["run-due"], deps), 1);
});

test("a corrupt store exits 2 instead of throwing", async () => {
  const dir = await project();
  const paths = schedulerPaths(dir);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.tasksFile, "{ not json");
  const { deps, stderr } = capture(dir, new FakeAgent());

  // A corrupt store is the machine's fault, not the caller's: exit 3.
  assert.equal(await main(["run-due"], deps), 3);
  assert.match(stderr.join("\n"), /error: corrupt_store: Invalid scheduler file/);
});

test("run executes a task immediately with a manual trigger", async () => {
  const dir = await project();
  const agent = new FakeAgent();
  const { deps, stdout } = capture(dir, agent);
  await main(["add", "--prompt", "Check CI", "--every", "30m"], deps);
  const [task] = JSON.parse((await captureJson(deps)).join("\n"));

  assert.equal(await main(["run", task.id], deps), 0);
  assert.match(stdout.join("\n"), /success/);
  const [run] = await listRuns(schedulerPaths(dir).runsDir);
  assert.equal(run.trigger, "manual");
});

test("remove deletes a task", async () => {
  const dir = await project();
  const { deps } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m"], deps);
  const [task] = JSON.parse((await captureJson(deps)).join("\n"));

  assert.equal(await main(["remove", task.id], deps), 0);
  assert.equal(JSON.parse((await captureJson(deps)).join("\n")).length, 0);
});

async function captureJson(deps: CliDeps): Promise<string[]> {
  const stdout: string[] = [];
  await main(["list", "--json"], { ...deps, stdout: (line) => stdout.push(line) });
  return stdout;
}

test("list shows the local project first, then other projects grouped under headers", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agents-cron-projects-"));
  const local = join(parent, "local");
  const other = join(parent, "other");
  const ghost = join(parent, "ghost");
  await Promise.all([local, other].map((dir) => mkdir(dir, { recursive: true })));
  const { deps, stdout } = capture(local, new FakeAgent());

  await main(["add", "--prompt", "local duty", "--every", "30m", "--name", "mine"], deps);
  await main(["add", "--prompt", "other duty", "--every", "30m", "--name", "theirs", "--project", other], deps);
  await main(["add", "--prompt", "ghost duty", "--every", "30m", "--name", "ghosty", "--project", ghost], deps);

  stdout.length = 0;
  assert.equal(await main(["list"], deps), 0);
  const text = stdout.join("\n");

  const localAt = text.indexOf("mine");
  const headerAt = text.indexOf(`other — ${other}`);
  const otherAt = text.indexOf("theirs");
  const ghostAt = text.indexOf("ghost duty");
  assert.ok(localAt >= 0, "local task line present");
  assert.ok(headerAt > localAt, "other project header follows the local task");
  assert.ok(otherAt > headerAt, "other project task follows its header");
  assert.match(text, /ghosty.*⚠ missing directory/);
});

test("run-due --all runs every project's due tasks from an unrelated directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agents-cron-projects-"));
  const nowhere = join(parent, "nowhere");
  const projA = join(parent, "proj-a");
  const projB = join(parent, "proj-b");
  await Promise.all([nowhere, projA, projB].map((dir) => mkdir(dir, { recursive: true })));
  const agent = new FakeAgent();
  const { deps } = capture(nowhere, agent);

  await main(["add", "--prompt", "a", "--at", new Date().toISOString(), "--project", projA], deps);
  await main(["add", "--prompt", "b", "--at", new Date().toISOString(), "--project", projB], deps);
  assert.equal(await main(["run-due", "--all"], deps), 0);
  assert.equal(agent.calls, 2);
});

test("prune without --project walks every project in the registry", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agents-cron-projects-"));
  const nowhere = join(parent, "nowhere");
  const projA = join(parent, "proj-a");
  const projB = join(parent, "proj-b");
  await Promise.all([nowhere, projA, projB].map((dir) => mkdir(dir, { recursive: true })));
  const { deps, stdout } = capture(nowhere, new FakeAgent());

  for (const proj of [projA, projB]) {
    await main(["add", "--prompt", proj.slice(-1), "--every", "30m", "--project", proj], deps);
  }
  const { loadRegistry } = await import("../src/registry.ts");
  const byPrompt = new Map((await loadRegistry()).map((task) => [task.prompt, task.id]));
  for (const proj of [projA, projB]) {
    const runsDir = schedulerPaths(proj).runsDir;
    for (let i = 0; i < 3; i += 1) {
      await writeRun(runsDir, {
        runId: `run_${proj.slice(-1)}${i}`, taskId: byPrompt.get(proj.slice(-1))!, trigger: "scheduled",
        startedAt: `2026-09-01T10:0${i}:00.000Z`, status: "success",
      });
    }
  }

  stdout.length = 0;
  assert.equal(await main(["prune", "--keep", "1"], deps), 0);
  assert.match(stdout.join("\n"), /Pruned 4 run\(s\)/);
});

test("--help prints usage like the help command", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  assert.equal(await main(["--help"], deps), 0);
  assert.match(stdout.join("\n"), /agents-cron <command>/);
});

test("interval schedules render in human units, not raw milliseconds", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agents-cron-projects-"));
  const dir = join(parent, "proj");
  await mkdir(dir, { recursive: true });
  const { deps, stdout } = capture(dir, new FakeAgent());

  await main(["add", "--prompt", "half hour", "--every", "30m"], deps);
  await main(["add", "--prompt", "hourly", "--every", "1h"], deps);
  await main(["add", "--prompt", "odd", "--every", "90s"], deps);

  stdout.length = 0;
  await main(["list"], deps);
  const text = stdout.join("\n");
  assert.match(text, /every 30m/);
  assert.match(text, /every 1h/);
  assert.match(text, /every 90s/);
  assert.doesNotMatch(text, /every \d{5,}ms/);
});

test("setup-notify refuses to run without a terminal instead of half-working", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  // A missing terminal is the machine's problem, not the caller's: exit 3.
  assert.equal(await main(["setup-notify"], deps), 3);
  assert.match(stderr.join("\n"), /error: no_tty: .*interactive/);
});

test("migrate-sessions refuses while another instance holds the run lock", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  const lock = await acquireLock(schedulerPaths(dir).lockFile);
  assert.ok(lock);
  try {
    assert.equal(await main(["migrate-sessions", "--project", dir], deps), 3);
    assert.match(stderr.join("\n"), /error: lock_busy: .*run lock/);
  } finally {
    await lock.release();
  }
});

test("migrate-sessions carries legacy transcripts into the store", async () => {
  const dir = await project();
  const store = await mkdtemp(join(tmpdir(), "agents-cron-store-"));
  const { deps, stdout } = capture(dir, new FakeAgent());
  const runId = "run_20261022T130000Z_migrat1";
  const paths = schedulerPaths(dir);
  await mkdir(join(paths.sessionsDir, "task_1"), { recursive: true });
  const legacy = join(paths.sessionsDir, "task_1", `${runId}.jsonl`);
  await writeFile(legacy, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-10-22T13:00:00.000Z", cwd: dir })}\n`);
  await writeRun(paths.runsDir, {
    runId,
    taskId: "task_1",
    trigger: "scheduled",
    startedAt: "2026-10-22T13:00:00.000Z",
    status: "success",
    finishedAt: "2026-10-22T13:01:00.000Z",
    exitCode: 0,
    sessionFile: legacy,
  } as RunRecord);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = store;
  try {
    assert.equal(await main(["migrate-sessions", "--project", dir], deps), 0);
    assert.match(stdout.join("\n"), /Moved 1 transcript/);

    const encoded = `--${realpathSync(dir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    await stat(join(store, "sessions", encoded, `task_1-${runId}.jsonl`));
    const record = await listRuns(paths.runsDir).then((runs) => runs.find((run) => run.runId === runId));
    assert.equal(record?.sessionFile, join(store, "sessions", encoded, `task_1-${runId}.jsonl`));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(store, { recursive: true, force: true });
  }
});

test("migrate-sessions --dry-run changes nothing", async () => {
  const dir = await project();
  const store = await mkdtemp(join(tmpdir(), "agents-cron-store-"));
  const { deps, stdout } = capture(dir, new FakeAgent());
  const paths = schedulerPaths(dir);
  await mkdir(join(paths.sessionsDir, "task_1"), { recursive: true });
  const legacy = join(paths.sessionsDir, "task_1", "run_20261022T130100Z_dryrun1.jsonl");
  await writeFile(legacy, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-10-22T13:01:00.000Z", cwd: dir })}\n`);
  await writeRun(paths.runsDir, {
    runId: "run_20261022T130100Z_dryrun1",
    taskId: "task_1",
    trigger: "scheduled",
    startedAt: "2026-10-22T13:01:00.000Z",
    status: "success",
    finishedAt: "2026-10-22T13:02:00.000Z",
    exitCode: 0,
    sessionFile: legacy,
  } as RunRecord);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = store;
  try {
    assert.equal(await main(["migrate-sessions", "--project", dir, "--dry-run"], deps), 0);
    assert.match(stdout.join("\n"), /Would move 1 transcript/);
    await stat(legacy);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(store, { recursive: true, force: true });
  }
});

test("add --notify-to routes the task and show prints the routing", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  assert.equal(
    await main(["add", "--prompt", "Check CI", "--every", "30m", "--notify", "always", "--notify-to", "feishu,mail"], deps),
    0,
  );
  const id = /Created (task_[^\s;]+)/.exec(stdout.join("\n"))![1];

  stdout.length = 0;
  assert.equal(await main(["show", id, "--json"], deps), 0);
  const task = JSON.parse(stdout.join("\n"));
  assert.deepEqual(task.notifyTo, ["feishu", "mail"]);
  assert.equal(task.notify, "always");

  stdout.length = 0;
  assert.equal(await main(["show", id], deps), 0);
  assert.match(stdout.join("\n"), /notify: always/);
  assert.match(stdout.join("\n"), /notify to: feishu, mail/);
});

test("add warns when --notify-to names a channel the project has not configured", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  // The warning now comes from addTask (shared by every creator) on real stderr.
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(await main(["add", "--prompt", "Check CI", "--every", "30m", "--notify-to", "ghost"], deps), 0);
  } finally {
    process.stderr.write = original;
  }
  assert.match(stdout.join("\n"), /Created task_/);
  assert.match(chunks.join(""), /no notification channel "ghost" in/);
});

// --- export / import (ADR 0009) ---

test("export prints a versioned definitions file to stdout, or writes it with --out", async () => {
  const dir = await project();
  const { deps } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "check CI", "--every", "5m", "--name", "watch"], deps);

  const printed = capture(dir, new FakeAgent());
  assert.equal(await main(["export"], printed.deps), 0);
  const file = JSON.parse(printed.stdout.join("\n"));
  assert.equal(file.version, 1);
  assert.equal(file.tasks.length, 1);
  assert.equal(file.tasks[0].name, "watch");
  assert.equal("id" in file.tasks[0], false);

  const target = join(dir, "exports", "tasks.json");
  const written = capture(dir, new FakeAgent());
  assert.equal(await main(["export", "--out", target], written.deps), 0);
  assert.match(written.stdout.join("\n"), /Wrote 1 task/);
  const fromDisk = JSON.parse(await readFile(target, "utf8"));
  assert.equal(fromDisk.tasks[0].prompt, "check CI");
});

test("import creates disabled tasks bound to the current project; --dry-run writes nothing", async () => {
  const source = await project();
  const target = await project();
  const seed = capture(source, new FakeAgent());
  await main(["add", "--prompt", "p", "--every", "5m", "--name", "watch"], seed.deps);
  const file = join(source, "tasks.export.json");
  await main(["export", "--out", file], seed.deps);

  const preview = capture(target, new FakeAgent());
  assert.equal(await main(["import", file, "--dry-run"], preview.deps), 0);
  assert.match(preview.stdout.join("\n"), /Would import 1 task/);
  const previewTasks = JSON.parse((await captureJson(preview.deps)).join("\n")).filter((task: { projectDir: string }) => task.projectDir === target);
  assert.equal(previewTasks.length, 0); // dry-run left the registry alone

  const applied = capture(target, new FakeAgent());
  assert.equal(await main(["import", file], applied.deps), 0);
  assert.match(applied.stdout.join("\n"), /Imported 1 task\(s\)/);
  assert.match(applied.stdout.join("\n"), /all start disabled/);

  const imported = JSON.parse((await captureJson(applied.deps)).join("\n")).filter((task: { projectDir: string }) => task.projectDir === target);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].enabled, false);
  assert.equal(imported[0].projectDir, target);

  // Importing the same file again skips the duplicate instead of doubling it.
  const again = capture(target, new FakeAgent());
  await main(["import", file], again.deps);
  const text = again.stdout.join("\n");
  assert.match(text, /skipped .* duplicate/);
  assert.match(text, /Imported 0 task\(s\)/);
});

test("import of a missing or malformed file exits 2 with the offending path", async () => {
  const dir = await project();
  const missing = capture(dir, new FakeAgent());
  assert.equal(await main(["import", join(dir, "nope.json")], missing.deps), 2);
  assert.match(missing.stderr.join("\n"), /nope\.json/);

  const bad = join(dir, "bad.json");
  await writeFile(bad, '{"version": 9, "exportedAt": "x", "tasks": []}', "utf8");
  const parsed = capture(dir, new FakeAgent());
  assert.equal(await main(["import", bad], parsed.deps), 2);
  assert.match(parsed.stderr.join("\n"), /version: 9/);
});

// --- dashboard lifecycle (no child is spawned here; the lifecycle suite owns that) ---

test("dashboard status and stop report an unstarted dashboard", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());

  assert.equal(await main(["dashboard", "status"], deps), 0);
  assert.match(stdout.join("\n"), /Not running/);

  stdout.length = 0;
  assert.equal(await main(["dashboard", "stop"], deps), 0);
  assert.match(stdout.join("\n"), /No dashboard running/);
});

test("dashboard status reports a dead registration as stale and removes it", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  const file = dashboardStateFile(dir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ pid: 999999999, port: 7383, url: "http://127.0.0.1:7383/", startedAt: "2026-11-02T09:00:00.000Z" }),
  );

  assert.equal(await main(["dashboard", "status"], deps), 0);
  assert.match(stdout.join("\n"), /Not running \(removed stale state\)/);
  assert.equal(existsSync(file), false);
});

// --- the agent-facing output contract (AXI) ---
// Each test below pins one promise the CLI makes to a machine reader: what a
// bare invocation answers, that unknown input is refused instead of guessed
// at, that truncation is stated, and that every success names its next step.

test("bare invocation answers with the task list, not usage", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m", "--name", "ci"], deps);

  stdout.length = 0;
  assert.equal(await main([], deps), 0);
  const text = stdout.join("\n");
  assert.match(text, /ci/);
  assert.doesNotMatch(text, /^\s+list \[/); // usage text, not data
});

test("an unknown flag is refused instead of silently ignored", async () => {
  const dir = await project();
  const { deps, stdout, stderr } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m"], deps);

  stdout.length = 0;
  assert.equal(await main(["list", "--bogus", "x"], deps), 2);
  assert.deepEqual(stdout, []); // nothing on stdout on failure
  assert.match(stderr.join("\n"), /^error: unknown_flag: no command accepts --bogus/);

  stderr.length = 0;
  assert.equal(await main(["list", "--limit", "2"], deps), 0);
  assert.equal(await main(["list", "--json", "stray"], deps), 2); // extra positionals too
  assert.match(stderr.join("\n"), /^error: usage: list: takes 0 positional/);
});

test("list states its total and says when --limit hid rows", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  for (const name of ["a", "b", "c"]) {
    await main(["add", "--prompt", name, "--every", "30m", "--name", name], deps);
  }

  stdout.length = 0;
  assert.equal(await main(["list", "--limit", "1"], deps), 0);
  const text = stdout.join("\n");
  assert.match(text, /tasks: 3 total/);
  assert.match(text, /2 task\(s\) hidden by --limit 1/);
  assert.match(text, /^next: agents-cron show /m);

  stdout.length = 0;
  assert.equal(await main(["list", "--limit", "0"], deps), 0);
  assert.doesNotMatch(stdout.join("\n"), /hidden/);
});

test("empty states say what is empty and what to run instead", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());

  assert.equal(await main(["list"], deps), 0);
  assert.match(stdout.join("\n"), /No scheduled tasks here or in any other project/);
  assert.match(stdout.join("\n"), /next: agents-cron add/);

  assert.equal(await main(["clear"], deps), 0);
  assert.match(stdout.join("\n"), /nothing to clear/);

  assert.equal(await main(["prune"], deps), 0);
  assert.match(stdout.join("\n"), /Pruned 0 run\(s\)/);

  assert.equal(await main(["run-due"], deps), 0);
  assert.match(stdout.join("\n"), /No due tasks/);
});

test("mutations report the state they produced, not just an acknowledgement", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  assert.equal(await main(["add", "--prompt", "Check CI", "--every", "30m", "--name", "ci"], deps), 0);
  const id = /Created (task_[^\s]+)/.exec(stdout.join("\n"))![1];
  assert.match(stdout.join("\n"), new RegExp(`${id} \\[enabled\\] ci — every 30m`));

  stdout.length = 0;
  assert.equal(await main(["disable", id], deps), 0);
  assert.match(stdout.join("\n"), new RegExp(`Disabled ${id}`));
  assert.match(stdout.join("\n"), /\[disabled\]/); // the state after, not before
  assert.match(stdout.join("\n"), new RegExp(`next: agents-cron enable ${id}`));

  stdout.length = 0;
  assert.equal(await main(["remove", id], deps), 0);
  assert.match(stdout.join("\n"), /Removed task_.*; 0 task\(s\) left/);
});

test("runs prints a task's history, newest first, with its own truncation", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m", "--name", "ci"], deps);
  const [task] = JSON.parse((await captureJson(deps)).join("\n"));

  for (let index = 0; index < 3; index += 1) {
    await writeRun(schedulerPaths(dir).runsDir, {
      runId: `run_20260901T10010${index}Z_runs${index}`,
      taskId: task.id,
      trigger: "manual",
      startedAt: `2026-09-01T10:0${index}:00.000Z`,
      finishedAt: `2026-09-01T10:0${index}:30.000Z`,
      status: index === 1 ? "error" : "success",
      ...(index === 1 ? { error: "provider unavailable" } : {}),
    });
  }

  stdout.length = 0;
  assert.equal(await main(["runs", task.id.slice(0, 9), "--limit", "2"], deps), 0);
  const text = stdout.join("\n");
  assert.match(text, /runs: 3 total — 2 success, 1 error/);
  assert.match(text, /provider unavailable/); // the error is on the line, not hidden
  assert.match(text, /1 older run\(s\) hidden/);
  assert.match(text, /^next: agents-cron show /m);
});

test("a missing task is bad input: exit 2, stderr only, nothing on stdout", async () => {
  const dir = await project();
  const { deps, stdout, stderr } = capture(dir, new FakeAgent());
  for (const command of [["show", "task_nope"], ["runs", "task_nope"], ["enable", "task_nope"], ["run", "task_nope"]]) {
    stdout.length = 0;
    stderr.length = 0;
    assert.equal(await main(command, deps), 2);
    assert.deepEqual(stdout, []);
    assert.match(stderr.join("\n"), /^error: input: Task not found: task_nope/);
  }
});

test("flags that contradict each other are refused, not resolved silently", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m"], deps);

  assert.equal(await main(["list", "--full", "--limit", "5"], deps), 2);
  assert.match(stderr.join("\n"), /^error: usage: --full shows everything/);

  stderr.length = 0;
  assert.equal(await main(["add", "--prompt", "x", "--every", "1h", "--timezone", "UTC"], deps), 2);
  assert.match(stderr.join("\n"), /^error: usage: --timezone only applies to --cron/);

  assert.equal(await main(["list", "--full", "--limit", "0"], deps), 0); // no contradiction
});

test("--json round-trips a mutation", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  assert.equal(await main(["add", "--prompt", "Check CI", "--every", "30m", "--name", "ci", "--json"], deps), 0);
  const created = JSON.parse(stdout.join("\n"));
  assert.equal(created.created.name, "ci");
  assert.equal(created.created.enabled, true);

  stdout.length = 0;
  assert.equal(await main(["disable", created.created.id, "--json"], deps), 0);
  assert.equal(JSON.parse(stdout.join("\n")).updated.enabled, false);
});

test("--json never truncates, so a cap alongside it is refused", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m"], deps);

  assert.equal(await main(["list", "--json", "--limit", "1"], deps), 2);
  assert.match(stderr.join("\n"), /^error: usage: list --json returns every record/);
  assert.equal(await main(["list", "--json"], deps), 0);
});

test("--json is refused where no JSON shape exists, instead of being ignored", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  assert.equal(await main(["migrate-sessions", "--json"], deps), 2);
  assert.match(stderr.join("\n"), /^error: unknown_flag: migrate-sessions: unknown flag --json/);
});

// --- the unknown-agent warning: one judgement, three entry points (#14) ---

test("the unknown-agent warning comes from the registry in play, with no test-double carve-out", async () => {
  const dir = await project();
  const agent = new FakeAgent();
  const { deps } = capture(dir, agent);
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // The injected registry knows exactly one adapter, "fake": creating a task
    // for it is a known agent, and nothing in product code names it.
    assert.equal(await main(["add", "--prompt", "Check CI", "--every", "30m", "--agent", "fake"], deps), 0);
    assert.equal(chunks.join(""), "");
    assert.deepEqual(agent.requested, []); // add never resolves an adapter

    // An id the injected registry does not know warns, and says what it knows.
    chunks.length = 0;
    assert.equal(await main(["add", "--prompt", "Check CI", "--every", "30m", "--agent", "nope"], deps), 0);
    assert.match(chunks.join(""), /no agent adapter named "nope" is registered \(known: fake\)/);
  } finally {
    process.stderr.write = original;
  }
});

test("import warns about a foreign agent id, dry run included", async () => {
  const source = await project();
  const { deps: sourceDeps } = capture(source, new FakeAgent());
  await main(["add", "--prompt", "audit", "--every", "1d", "--agent", "codex", "--name", "audit"], sourceDeps);
  const file = join(source, "export.json");
  assert.equal(await main(["export", "--out", file], sourceDeps), 0);

  const target = await project();
  const { deps } = capture(target, new FakeAgent());
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // Previewing is exactly when "this would never run here" has to be said.
    assert.equal(await main(["import", file, "--dry-run"], deps), 0);
    assert.match(chunks.join(""), /no agent adapter named "codex" is registered \(known: fake\)/);

    chunks.length = 0;
    assert.equal(await main(["import", file], deps), 0);
    assert.match(chunks.join(""), /no agent adapter named "codex" is registered/);
  } finally {
    process.stderr.write = original;
  }
});

test("the registry lock and the run lock are different codes for different situations", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  await main(["add", "--prompt", "Check CI", "--every", "30m"], deps);

  // A busy project Run Lock is normal: another instance is executing, so
  // run-due reports it and exits 0 — never as a broken environment.
  const runLock = await acquireLock(schedulerPaths(dir).lockFile);
  assert.ok(runLock);
  try {
    assert.equal(await main(["run-due"], deps), 0);
    assert.equal(await main(["run", "task_whatever"], deps), 2); // unknown id, before the lock matters
  } finally {
    await runLock.release();
  }
  assert.doesNotMatch(stderr.join("\n"), /registry_lock_busy/);

  // A busy Registry Lock means a write did not land; it is the environment's
  // fault (exit 3) and carries its own code so a script can tell the two apart.
  const { registryPaths } = await import("../src/paths.ts");
  const registryLock = await acquireLock(registryPaths().lockFile);
  assert.ok(registryLock);
  try {
    const outcome = await main(["add", "--prompt", "second", "--every", "30m"], deps);
    assert.equal(outcome, 3);
    assert.match(stderr.join("\n"), /^error: registry_lock_busy: task registry lock busy/m);
    assert.match(stderr.join("\n"), /nothing was saved/);
  } finally {
    await registryLock.release();
  }
});
