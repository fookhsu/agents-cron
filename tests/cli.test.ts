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
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "../src/agents/registry.ts";
import type { AgentAdapter, AgentRunResult } from "../src/agents/types.ts";
import { main, type CliDeps } from "../src/cli.ts";
import { schedulerPaths } from "../src/paths.ts";
import { listRuns, writeRun } from "../src/runs.ts";

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
