import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "../src/agents/pi/tools.ts";
import { ensureToolSearchActive } from "../src/agents/pi/tool-search.ts";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function captureTool(): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const pi = {
    registerTool(definition: RegisteredTool) {
      tool = definition;
    },
  } as unknown as ExtensionAPI;
  registerTools(pi);
  return tool!;
}

test("schedule_task is exposed deferred so it stays out of the resident manifest", () => {
  const tool = captureTool();

  assert.equal(tool.exposure, "deferred");
  assert.equal(tool.name, "schedule_task");
});

test("schedule_task show returns the task with its prompt", async () => {
  // The registry is machine-global; point it at a throwaway home so the
  // assertion never touches real tasks.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-toolshow-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const cwd = await mkdtemp(join(tmpdir(), "agents-cron-toolshow-cwd-"));
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);
    const { addTask } = await import("../src/task-service.ts");
    const task = await addTask(cwd, {
      prompt: "Check the CI",
      schedule: { kind: "interval", every: "30m" },
    });

    const outcome = await captureTool().execute("call", { action: "show", id: task.id }, undefined, undefined, {
      cwd,
    } as never);

    const text = outcome.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    assert.match(text, /prompt:\nCheck the CI/);
    assert.deepEqual(outcome.details, task);
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("guidelines require clarifying instead of guessing an unspecified schedule", () => {
  const joined = (captureTool().promptGuidelines ?? []).join("\n").toLowerCase();

  assert.match(joined, /ask the user/);
  assert.match(joined, /guess/);
});

test("guidelines require repeating id and next run after creating a task", () => {
  const joined = (captureTool().promptGuidelines ?? []).join("\n").toLowerCase();

  assert.match(joined, /next run/);
  assert.match(joined, /\bid\b/);
});

function fakePi(tools: { name: string; reachesTools?: unknown }[], active: string[], setActive: (names: string[]) => void): ExtensionAPI {
  return {
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: setActive,
  } as unknown as ExtensionAPI;
}

test("ensureToolSearchActive activates a registered inactive tool_search", () => {
  const calls: string[][] = [];
  const pi = fakePi([{ name: "tool_search", reachesTools: () => "all" }], ["read", "bash"], (names) => calls.push(names));

  ensureToolSearchActive(pi);

  assert.deepEqual(calls, [["read", "bash", "tool_search"]]);
});

test("ensureToolSearchActive is a no-op when tool_search is already active", () => {
  const calls: string[][] = [];
  const pi = fakePi([{ name: "tool_search", reachesTools: () => "all" }], ["tool_search"], (names) => calls.push(names));

  ensureToolSearchActive(pi);

  assert.equal(calls.length, 0);
});

test("ensureToolSearchActive does nothing when tool_search is not registered", () => {
  const calls: string[][] = [];
  const pi = fakePi([{ name: "codemode" }], [], (names) => calls.push(names));

  ensureToolSearchActive(pi);

  assert.equal(calls.length, 0);
});

test("schedule_task add accepts notify level and notifyTo routing", async () => {
  // The registry is machine-global; point it at a throwaway home so the
  // assertion never touches real tasks.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-toolnotify-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const cwd = await mkdtemp(join(tmpdir(), "agents-cron-toolnotify-cwd-"));
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);

    const outcome = await captureTool().execute(
      "call",
      {
        action: "add",
        prompt: "Check the CI",
        schedule: { kind: "interval", every: "30m" },
        notify: "always",
        notifyTo: ["feishu"],
      },
      undefined,
      undefined,
      { cwd } as never,
    );

    assert.match(
      outcome.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join(""),
      /Created task_/,
    );
    const created = outcome.details as { notify?: string; notifyTo?: string[] };
    assert.equal(created.notify, "always");
    assert.deepEqual(created.notifyTo, ["feishu"]);
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("schedule_task update reconfigures a task's model and thinking", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-toolset-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const cwd = await mkdtemp(join(tmpdir(), "agents-cron-toolset-cwd-"));
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);
    const { addTask } = await import("../src/task-service.ts");
    const task = await addTask(cwd, { prompt: "Check the CI", schedule: { kind: "interval", every: "30m" } });

    const outcome = await captureTool().execute(
      "call",
      { action: "update", id: task.id, model: "anthropic/claude-opus-4-5", thinking: "high" },
      undefined,
      undefined,
      { cwd } as never,
    );

    const text = outcome.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    assert.match(text, new RegExp(`Updated ${task.id}`));
    assert.match(text, /model: anthropic\/claude-opus-4-5/);
    assert.match(text, /thinking: high/);
    const updated = outcome.details as { model?: string; thinking?: string };
    assert.equal(updated.model, "anthropic/claude-opus-4-5");
    assert.equal(updated.thinking, "high");

    // Empty strings clear the overrides back to the project and user defaults.
    const cleared = await captureTool().execute(
      "call",
      { action: "update", id: task.id, model: "", thinking: "" },
      undefined,
      undefined,
      { cwd } as never,
    );
    const gone = cleared.details as { model?: string; thinking?: string };
    assert.equal("model" in gone, false);
    assert.equal("thinking" in gone, false);
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("schedule_task update rejects an empty patch and a bad thinking level", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "agents-cron-toolbad-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  const cwd = await mkdtemp(join(tmpdir(), "agents-cron-toolbad-cwd-"));
  try {
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([]);
    const { addTask } = await import("../src/task-service.ts");
    const task = await addTask(cwd, { prompt: "Check the CI", schedule: { kind: "interval", every: "30m" } });

    await assert.rejects(
      captureTool().execute("call", { action: "update", id: task.id }, undefined, undefined, { cwd } as never),
      /set requires at least one of/,
    );
    await assert.rejects(
      captureTool().execute("call", { action: "update", id: task.id, thinking: "deep" }, undefined, undefined, { cwd } as never),
      /--thinking must be one of/,
    );
  } finally {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
