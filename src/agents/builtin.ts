import { registerAgent } from "./registry.ts";

/**
 * Composition root for built-in adapters. Importing this module only records
 * lazy loaders, so no agent SDK is imported until a run actually resolves it.
 * Registration order decides the default agent: the first one registered
 * serves tasks that name no agent.
 */
registerAgent("pi", "Pi", async () => {
  const { createPiAdapter } = await import("./pi/adapter.ts");
  return createPiAdapter();
});

registerAgent("claude", "Claude Code", async () => {
  const { createClaudeAdapter } = await import("./claude/adapter.ts");
  return createClaudeAdapter();
});
