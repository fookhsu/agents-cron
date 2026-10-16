import test from "node:test";
import assert from "node:assert/strict";
import { listAgents, registerAgent, resolveAgent, UnknownAgentError } from "../src/agents/registry.ts";
import type { AgentAdapter } from "../src/agents/types.ts";

const stub: AgentAdapter = { id: "stub", displayName: "Stub", run: async () => ({}) };

test("registers and resolves an adapter by id", async () => {
  registerAgent("stub-test", "Stub Test", () => stub);

  assert.equal((await resolveAgent("stub-test")).id, "stub");
  assert.deepEqual(
    listAgents().find((agent) => agent.id === "stub-test"),
    { id: "stub-test", displayName: "Stub Test" },
  );
});

test("rejects an unknown agent id with the registered agents listed", async () => {
  const error = await resolveAgent("does-not-exist").catch((caught: unknown) => caught);

  assert.ok(error instanceof UnknownAgentError);
  assert.match((error as Error).message, /Unknown agent "does-not-exist"/);
});

test("built-in adapters load lazily; pi stays the default agent", async () => {
  await import("../src/agents/builtin.ts");

  assert.ok(listAgents().some((agent) => agent.id === "pi"));
  assert.equal((await resolveAgent("pi")).displayName, "Pi");
});

test("the Claude Code adapter registers behind pi", async () => {
  await import("../src/agents/builtin.ts");

  assert.ok(listAgents().some((agent) => agent.id === "claude"));
  assert.equal((await resolveAgent("claude")).displayName, "Claude Code");
});
