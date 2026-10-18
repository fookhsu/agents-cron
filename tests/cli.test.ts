import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "../src/agents/registry.ts";
import type { AgentAdapter, AgentRunResult } from "../src/agents/types.ts";
import { main, type CliDeps } from "../src/cli.ts";
import { schedulerPaths } from "../src/paths.ts";
import { listRuns } from "../src/runs.ts";

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
  return mkdtemp(join(tmpdir(), "agent-cron-cli-"));
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
