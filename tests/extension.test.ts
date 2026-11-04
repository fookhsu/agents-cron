import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/agents/pi/extension.ts";
import { LEGACY_TASK_SESSION_ENV, TASK_SESSION_ENV } from "../src/agents/pi/env.ts";

/**
 * The cross-package flag the factory uses to keep a second installed copy of
 * this extension inert (the @fookhsu/pi-scheduler shim forwards to the same
 * extension, so both packages can be present). Reaching for it by name keeps
 * the test honest: it is process-level state, and that is exactly what makes
 * `/reload` subtle.
 */
const LOADED_FLAG = Symbol.for("agents-cron.extension.loaded");
const scope = globalThis as Record<symbol, boolean>;

type Loaded = {
  api: ExtensionAPI;
  commands: string[];
  tools: string[];
  shutdown: (reason: string) => void;
};

/**
 * One extension load. pi builds a fresh ExtensionAPI per loaded extension and a
 * fresh command/tool registry per runtime, so two of these describe a reload as
 * faithfully as two module instances would: the code that runs is the same, and
 * the only state shared between loads is globalThis.
 */
function loadStub(): Loaded {
  const commands: string[] = [];
  const tools: string[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => void)[]>();

  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string) => commands.push(name),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
  } as unknown as ExtensionAPI;

  const fire = (event: string, payload: unknown): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload, { cwd: process.cwd(), ui: { notify() {} } });
  };

  extension(api);
  return { api, commands, tools, shutdown: (reason) => fire("session_shutdown", { reason }) };
}

/** Leave no flag behind for the next test, and make sure no Task Session env leaks in. */
function reset(): void {
  delete scope[LOADED_FLAG];
  delete process.env[TASK_SESSION_ENV];
  delete process.env[LEGACY_TASK_SESSION_ENV];
}

test("a reloaded runtime registers /schedule and schedule_task again", () => {
  reset();
  const first = loadStub();
  assert.deepEqual(first.commands.sort(), ["loop", "remind", "schedule"]);
  assert.ok(first.tools.includes("schedule_task"));

  // `/reload` (or `/new`, `/resume`, `/fork`) tears the runtime down first…
  first.shutdown("reload");
  // …then pi re-imports this module into a brand-new, empty registry.
  const second = loadStub();
  assert.deepEqual(second.commands.sort(), ["loop", "remind", "schedule"], "commands survive a reload");
  assert.ok(second.tools.includes("schedule_task"), "tools survive a reload");
  reset();
});

test("a second copy of the package stays inert, so tool registration cannot conflict", () => {
  reset();
  // pi loads the replacement runtime in the same process: the first copy claims
  // the runtime, and the @fookhsu/pi-scheduler shim loading next must register
  // nothing (duplicate names fail the load with "Tool ... conflicts with ...").
  const first = loadStub();
  assert.equal(first.commands.length, 3);

  const shim = loadStub();
  assert.deepEqual(shim.commands, [], "the second copy registers no commands");
  assert.deepEqual(shim.tools, [], "the second copy registers no tools");
  reset();
});

test("a Task Session never claims the flag", () => {
  reset();
  process.env[TASK_SESSION_ENV] = "1";
  const taskSession = loadStub();
  assert.deepEqual(taskSession.commands, []);
  assert.equal(scope[LOADED_FLAG], undefined, "the scheduler stays inert without claiming the runtime");
  reset();
});
