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
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "../src/agents/registry.ts";
import type { AgentAdapter, AgentRunResult } from "../src/agents/types.ts";
import { main, type CliDeps } from "../src/cli.ts";
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

test("unknown commands exit with a config error", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  assert.equal(await main(["frobnicate"], deps), 2);
  assert.match(stderr.join("\n"), /Unknown command/);
});

test("lists an empty project without failing", async () => {
  const dir = await project();
  const { deps, stdout } = capture(dir, new FakeAgent());
  assert.equal(await main(["list"], deps), 0);
  assert.match(stdout.join("\n"), /No scheduled tasks/);
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

  assert.equal(await main(["run-due"], deps), 2);
  assert.match(stderr.join("\n"), /Invalid scheduler file/);
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
  assert.equal(await main(["setup-notify"], deps), 2);
  assert.match(stderr.join("\n"), /interactive/);
});

test("migrate-sessions refuses while another instance holds the run lock", async () => {
  const dir = await project();
  const { deps, stderr } = capture(dir, new FakeAgent());
  const lock = await acquireLock(schedulerPaths(dir).lockFile);
  assert.ok(lock);
  try {
    assert.equal(await main(["migrate-sessions", "--project", dir], deps), 2);
    assert.match(stderr.join("\n"), /run lock/);
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
  const { deps, stdout, stderr } = capture(dir, new FakeAgent());
  assert.equal(await main(["add", "--prompt", "Check CI", "--every", "30m", "--notify-to", "ghost"], deps), 0);
  assert.match(stderr.join("\n"), /no notification channel "ghost" in/);
});
