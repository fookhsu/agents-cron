import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands, parseExportArgs, parseTrailingFlags, parseSetSpec } from "../src/agents/pi/commands.ts";

type Registered = {
  description: string;
  getArgumentCompletions?: (args: string) => Promise<unknown[] | null> | unknown[] | null;
  handler: (args: string, ctx: unknown) => Promise<void>;
};

type EventHandler = (event: unknown, ctx: unknown) => void | Promise<void>;

function stubPi(): {
  api: ExtensionAPI;
  commands: Map<string, Registered>;
  events: Map<string, EventHandler[]>;
} {
  const commands = new Map<string, Registered>();
  const events = new Map<string, EventHandler[]>();
  const api = {
    registerCommand: (name: string, definition: Registered) => commands.set(name, definition),
    on: (event: string, handler: EventHandler) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  registerCommands(api);
  return { api, commands, events };
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

test("every command registers its argument completions and learns the cwd from session_start", async () => {
  const { commands, events } = stubPi();

  for (const name of ["loop", "remind", "schedule"]) {
    assert.equal(typeof commands.get(name)!.getArgumentCompletions, "function", `${name} completes arguments`);
  }

  const handlers = events.get("session_start") ?? [];
  assert.ok(handlers.length > 0, "subscribes to session_start");
  await handlers[0]({ type: "session_start", reason: "startup" }, { cwd: "/some/project" });
  // Until a real project has tasks, the remembered cwd still routes /schedule
  // to the action list instead of bailing with null.
  const items = await commands.get("schedule")!.getArgumentCompletions!("rem");
  assert.ok(Array.isArray(items) && items.some((item) => (item as { value: string }).value === "remove"));
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
    // The detail block is the CLI's `show`, word for word: one formatter for
    // every surface (see src/format.ts).
    assert.match(notices[0].message, new RegExp(`^${task.id} \\[enabled\\] -$`, "m"));
    assert.match(notices[0].message, /^schedule: every 30m$/m);
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

// --- Model configuration: trailing flags at creation, /schedule set after ---

/** A throwaway registry home plus the registered commands, for one test. */
async function freshSchedule() {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-set-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const { saveRegistry } = await import("../src/registry.ts");
  await saveRegistry([]);
  const restore = async () => {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
  };
  return { commands: stubPi().commands, restore };
}

test("parseTrailingFlags strips model config flags and validates thinking", () => {
  const flags = parseTrailingFlags('"*/5 * * * *" check CI --thinking high --model sonnet:low --agent codex --to feishu');
  assert.equal(flags.rest, '"*/5 * * * *" check CI');
  assert.equal(flags.thinking, "high");
  assert.equal(flags.model, "sonnet:low");
  assert.equal(flags.agent, "codex");
  assert.deepEqual(flags.to, ["feishu"]);

  assert.throws(() => parseTrailingFlags("30m p --thinking turbo"), /--thinking must be one of/);
});

test("parseSetSpec maps flags to a patch; - clears and lists split", () => {
  const patch = parseSetSpec('--model haiku --thinking max --tools read,bash --notify always --to feishu,mail --name "night audit"');
  assert.equal(patch.model, "haiku");
  assert.equal(patch.thinking, "max");
  assert.deepEqual(patch.tools, ["read", "bash"]);
  assert.equal(patch.notify, "always");
  assert.deepEqual(patch.notifyTo, ["feishu", "mail"]);
  assert.equal(patch.name, "night audit");

  const cleared = parseSetSpec("--model - --thinking - --tools - --notify -");
  assert.equal(cleared.model, "");
  assert.equal(cleared.thinking, "");
  assert.deepEqual(cleared.tools, []);
  assert.equal(cleared.notify, "");

  assert.throws(() => parseSetSpec(""), /Usage: \/schedule set/);
  assert.throws(() => parseSetSpec("--model"), /--model requires a value/);
  assert.throws(() => parseSetSpec("--bogus x"), /Unexpected "--bogus"/);
  assert.throws(() => parseSetSpec("--notify sometimes"), /--notify must be one of/);
});

test("/schedule set reconfigures an existing task's model and thinking", async () => {
  const { commands, restore } = await freshSchedule();
  const { ctx, notices } = stubCtx();
  try {
    const { addTask, listTasks } = await import("../src/task-service.ts");
    const created = await addTask((ctx as { cwd: string }).cwd, {
      prompt: "check CI",
      schedule: { kind: "interval", every: "30m" },
    });

    await commands.get("schedule")!.handler(`set ${created.id} --model anthropic/claude-opus-4-5 --thinking high`, ctx);

    assert.equal(notices[0].level, "info");
    assert.match(notices[0].message, new RegExp(`Updated ${created.id}`));
    assert.match(notices[0].message, /model: anthropic\/claude-opus-4-5/);
    assert.match(notices[0].message, /thinking: high/);
    const [stored] = await listTasks((ctx as { cwd: string }).cwd);
    assert.equal(stored.model, "anthropic/claude-opus-4-5");
    assert.equal(stored.thinking, "high");
  } finally {
    await restore();
  }
});

test("/schedule set clears a field with a value of -", async () => {
  const { commands, restore } = await freshSchedule();
  const { ctx } = stubCtx();
  try {
    const { addTask, listTasks } = await import("../src/task-service.ts");
    const created = await addTask((ctx as { cwd: string }).cwd, {
      prompt: "check CI",
      schedule: { kind: "interval", every: "30m" },
      model: "haiku",
      thinking: "low",
    });

    await commands.get("schedule")!.handler(`set ${created.id} --thinking -`, ctx);

    const [stored] = await listTasks((ctx as { cwd: string }).cwd);
    assert.equal("thinking" in stored, false);
    assert.equal(stored.model, "haiku"); // untouched fields stay
  } finally {
    await restore();
  }
});

test("/loop pins the model at creation with trailing flags", async () => {
  const { commands, restore } = await freshSchedule();
  const { ctx } = stubCtx();
  try {
    await commands.get("loop")!.handler("30m check CI --model sonnet:high --thinking low --agent pi", ctx);

    const { listTasks } = await import("../src/task-service.ts");
    const [task] = await listTasks((ctx as { cwd: string }).cwd);
    assert.equal(task.prompt, "check CI");
    assert.equal(task.model, "sonnet:high");
    assert.equal(task.thinking, "low");
    assert.equal(task.agent, "pi");
  } finally {
    await restore();
  }
});

test("an invalid trailing --thinking errors without creating a task", async () => {
  const { commands, restore } = await freshSchedule();
  const { ctx, notices } = stubCtx();
  try {
    await commands.get("loop")!.handler("30m check CI --thinking very", ctx);

    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "error");
    assert.match(notices[0].message, /--thinking must be one of/);
    const { loadRegistry } = await import("../src/registry.ts");
    assert.deepEqual(await loadRegistry(), []);
  } finally {
    await restore();
  }
});

test("/schedule show lists the task's model configuration", async () => {
  const { commands, restore } = await freshSchedule();
  const { ctx, notices } = stubCtx();
  try {
    const { addTask } = await import("../src/task-service.ts");
    const created = await addTask((ctx as { cwd: string }).cwd, {
      prompt: "check CI",
      schedule: { kind: "interval", every: "30m" },
      model: "anthropic/claude-opus-4-5",
      thinking: "high",
      agent: "pi",
    });

    await commands.get("schedule")!.handler(`show ${created.id}`, ctx);

    const text = notices[0].message;
    assert.match(text, /agent: pi/);
    assert.match(text, /model: anthropic\/claude-opus-4-5/);
    assert.match(text, /thinking: high/);
  } finally {
    await restore();
  }
});

// --- /schedule dashboard: the detached lifecycle ---

test("/schedule dashboard status reports a dashboard that is not running", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-dash-cmd-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);

    await commands.get("schedule")!.handler("dashboard status", ctx);

    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "info");
    assert.match(notices[0].message, /Not running/);
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("/schedule dashboard with an unknown action names the valid forms", async () => {
  const { commands } = stubPi();
  const { ctx, notices } = stubCtx();

  await commands.get("schedule")!.handler("dashboard bogus", ctx);

  assert.equal(notices.length, 1);
  assert.equal(notices[0].level, "error");
  assert.match(notices[0].message, /Unknown dashboard action "bogus"/);
  assert.match(notices[0].message, /\/schedule dashboard \[start\|stop\|status\]/);
});

test("/schedule export takes the CLI's --out spelling as well as a bare file", () => {
  // Same field, same word on both surfaces: `--out` is what the CLI documents,
  // and the bare positional stays for muscle memory.
  assert.deepEqual(parseExportArgs([]), { all: false });
  assert.deepEqual(parseExportArgs(["backup.json"]), { out: "backup.json", all: false });
  assert.deepEqual(parseExportArgs(["--out", "backup.json"]), { out: "backup.json", all: false });
  assert.deepEqual(parseExportArgs(["backup.json", "--all"]), { out: "backup.json", all: true });

  // Refused instead of resolved: an unknown flag, a missing value, two targets.
  assert.throws(() => parseExportArgs(["--bogus"]), /Unexpected "--bogus"/);
  assert.throws(() => parseExportArgs(["--out"]), /--out needs a file/);
  assert.throws(() => parseExportArgs(["--out", "--all"]), /--out needs a file/);
  assert.throws(() => parseExportArgs(["a.json", "--out", "b.json"]), /one destination/);
});
