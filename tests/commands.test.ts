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
  for (const action of ["list", "add", "enable", "disable", "run", "remove", "runs", "show", "open", "clear", "help"]) {
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
