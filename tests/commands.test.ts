import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "../src/agents/pi/commands.ts";

type Registered = {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
};

function stubPi(): { api: ExtensionAPI; commands: Map<string, Registered> } {
  const commands = new Map<string, Registered>();
  const api = {
    registerCommand: (name: string, definition: Registered) => commands.set(name, definition),
  } as unknown as ExtensionAPI;
  registerCommands(api);
  return { api, commands };
}

function stubCtx(): { ctx: unknown; notices: { message: string; level: string }[] } {
  const notices: { message: string; level: string }[] = [];
  return {
    notices,
    ctx: {
      cwd: mkdtempSync(join(tmpdir(), "agents-cron-commands-")),
      ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
    },
  };
}

test("registers the schedule command and mentions help in its description", () => {
  const { commands } = stubPi();

  assert.ok(commands.has("schedule"));
  assert.match(commands.get("schedule")!.description, /help/);
});

test("/schedule help shows every action", async () => {
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();

  await commands.get("schedule")!.handler("help", ctx);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "info");
  for (const action of ["list", "add", "enable", "disable", "run", "remove", "runs", "show", "open", "export", "import", "clear", "help"]) {
    assert.match(notices[0].message, new RegExp(`\\b${action}\\b`), `help mentions ${action}`);
  }
});

test("/schedule with an unknown action errors and points at help", async () => {
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();

  await commands.get("schedule")!.handler("bogus", ctx);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "error");
  assert.match(notices[0].message, /Unknown action "bogus"/);
  assert.match(notices[0].message, /Usage: \/schedule <action>/);
});

test("/remind usage errors teach the duration syntax", async () => {
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();

  // Missing "in": neither reminder shape matches — the usage line must show units.
  await commands.get("remind")!.handler("45m check the PR", ctx);
  assert.equal(notices[0].level, "error");
  assert.match(notices[0].message, /Usage: \/remind in <duration> <prompt>/);
  assert.match(notices[0].message, /30s, 5m, 2h, 1d/);

  // A bare number parses as neither shape nor duration: the duration error
  // carries the same hint.
  await commands.get("remind")!.handler("in 45 check the PR", ctx);
  assert.match(notices[1].message, /Invalid duration: 45/);
  assert.match(notices[1].message, /30s, 5m, 2h, 1d/);
});

test("/loop and /schedule add usage errors teach the schedule syntax", async () => {
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();

  await commands.get("loop")!.handler("", ctx);
  assert.equal(notices[0].level, "error");
  assert.match(notices[0].message, /Usage: \/loop <duration\|cron> <prompt>/);
  assert.match(notices[0].message, /30s, 5m, 2h, 1d/);
  assert.match(notices[0].message, /@daily/);

  await commands.get("schedule")!.handler("add", ctx);
  assert.match(notices[1].message, /Usage: \/schedule add <duration\|cron> <prompt>/);
  assert.match(notices[1].message, /30s, 5m, 2h, 1d/);
});

test("a known action without an id still asks for the id", async () => {
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();

  await commands.get("schedule")!.handler("enable", ctx);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "error");
  assert.equal(notices[0].message, "/schedule enable requires a task id");
});

test("/schedule show prints the task's prompt", async () => {
  // The registry is machine-global; point it at a throwaway home so the
  // assertion never touches real tasks.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-show-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const { saveRegistry } = await import("../src/registry.ts");
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();
  try {
    await saveRegistry([]);
    const { addTask } = await import("../src/task-service.ts");
    const task = await addTask((ctx as { cwd: string }).cwd, {
      prompt: "Check the CI",
      schedule: { kind: "interval", every: "30m" },
    });

    await commands.get("schedule")!.handler("show " + task.id, ctx);

    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "info");
    assert.match(notices[0].message, new RegExp(`\\[enabled\\] - — every`));
    assert.match(notices[0].message, /prompt:\nCheck the CI/);
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    const { rm } = await import("node:fs/promises");
    await rm(home, { recursive: true, force: true });
  }
});

test("/schedule with no args defaults to listing tasks", async () => {
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();

  await commands.get("schedule")!.handler("", ctx);

  // The registry is global, so the message depends on the machine's real
  // tasks; only the routing to the list action is asserted.
  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "info");
  assert.match(notices[0].message, /task_|No scheduled tasks\./);
});

test("/remind routes notifications with trailing --to and --notify flags", async () => {
  // The registry is machine-global; point it at a throwaway home so the
  // assertion never touches real tasks.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-remind-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);
    await commands.get("remind")!.handler("in 45m check the PR --to feishu,mail --notify always", ctx);

    const { listTasks } = await import("../src/task-service.ts");
    const [task] = await listTasks((ctx as { cwd: string }).cwd);
    assert.ok(task, "the reminder created a task");
    assert.equal(task.prompt, "check the PR"); // flags stripped from the prompt
    assert.equal(task.schedule.kind, "once");
    assert.deepEqual(task.notifyTo, ["feishu", "mail"]);
    assert.equal(task.notify, "always");
    assert.match(notices[0].message, /Created task_/);
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("/loop routes notifications with a trailing --to flag", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-loop-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const { commands } = stubPi();
  const { ctx } = stubCtx();
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);
    await commands.get("loop")!.handler("30m check CI --to feishu", ctx);

    const { listTasks } = await import("../src/task-service.ts");
    const [task] = await listTasks((ctx as { cwd: string }).cwd);
    assert.ok(task, "the loop created a task");
    assert.equal(task.prompt, "check CI");
    assert.equal(task.schedule.kind, "interval");
    assert.deepEqual(task.notifyTo, ["feishu"]);
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("an invalid trailing --notify value errors without creating a task", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-badflag-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);
    await commands.get("remind")!.handler("in 5m x --notify sometimes", ctx);

    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "error");
    assert.match(notices[0].message, /--notify must be one of: always, error, never/);
    const { loadRegistry } = await import("../src/registry.ts");
    assert.deepEqual(await loadRegistry(), []);
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("/schedule export writes agents-cron.tasks.json and /schedule import round-trips it", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-port-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const { commands } = stubPi();
  const source = stubCtx();
  const target = stubCtx();
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);
    await commands.get("schedule")!.handler('add 5m check CI', source.ctx);

    await commands.get("schedule")!.handler("export", source.ctx);

    const file = join((source.ctx as { cwd: string }).cwd, "agents-cron.tasks.json");
    assert.ok(existsSync(file), "export wrote the default file");
    const exported = JSON.parse(await readFile(file, "utf8"));
    assert.equal(exported.version, 1);
    assert.equal(exported.tasks[0].prompt, "check CI");
    assert.equal("id" in exported.tasks[0], false);

    await commands.get("schedule")!.handler(`import ${file}`, target.ctx);

    const { listTasks } = await import("../src/task-service.ts");
    const [task] = (await listTasks((target.ctx as { cwd: string }).cwd))
      .filter((entry) => entry.projectDir === (target.ctx as { cwd: string }).cwd);
    assert.ok(task, "the import created a task in the target project");
    assert.equal(task.prompt, "check CI");
    assert.equal(task.enabled, false); // imports start disabled
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("/schedule import names the file when it cannot be read", async () => {
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();

  await commands.get("schedule")!.handler("import /definitely/not/here.json", ctx);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "error");
  assert.match(notices[0].message, /not\/here\.json/);
});

test("/unschedule is gone and /schedule delete is no longer an alias — remove is the one path", async () => {
  const { commands } = stubPi();
  assert.equal(commands.has("unschedule"), false);

  const { ctx, notices } = stubCtx();
  await commands.get("schedule")!.handler("delete task_abcd", ctx);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "error");
  assert.match(notices[0].message, /Unknown action "delete"/);
});
