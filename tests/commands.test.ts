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
  for (const action of ["list", "add", "enable", "disable", "run", "remove", "runs", "open", "clear", "help"]) {
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
