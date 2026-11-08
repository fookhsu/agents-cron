import type { AgentAdapter } from "./types.ts";

export type AgentInfo = { id: string; displayName: string };

/** Loads an adapter on first use, so unused agent SDKs never get imported. */
export type AgentLoader = () => AgentAdapter | Promise<AgentAdapter>;

const loaders = new Map<string, AgentLoader>();
const displayNames = new Map<string, string>();

/**
 * The registry an adapter plugs into. Registration order decides the default
 * agent: the first one registered serves tasks that name no agent.
 */
export function registerAgent(id: string, displayName: string, load: AgentLoader): void {
  if (!loaders.has(id)) displayNames.set(id, displayName);
  loaders.set(id, load);
}

export function listAgents(): AgentInfo[] {
  return [...loaders].map(([id]) => ({ id, displayName: displayNames.get(id) ?? id }));
}

/**
 * The warning lines behind an agent id that no registered adapter answers to.
 * A task's `agent` is a cross-machine value — exporting on a machine without
 * claude and importing on one that has it is a legal path — so this is a
 * warning, never a rejection: a task may be created before its adapter is
 * installed, and the alternative is a user who cannot schedule the work that
 * made them install the package. `registered` is the registry actually in
 * play, so a caller with an injected one judges against its own set.
 */
export function unknownAgentWarnings(registered: AgentInfo[], agent?: string): string[] {
  if (!agent) return [];
  const known = registered.map((info) => info.id);
  if (known.length === 0 || known.includes(agent)) return [];
  return [`no agent adapter named "${agent}" is registered (known: ${known.join(", ")}); runs will fail until one is.`];
}

export function defaultAgentId(): string | undefined {
  return loaders.keys().next().value;
}

export class UnknownAgentError extends Error {
  constructor(id: string) {
    const known = listAgents().map((agent) => agent.id);
    super(`Unknown agent "${id}". Registered agents: ${known.length ? known.join(", ") : "(none)"}`);
  }
}

export async function resolveAgent(id?: string): Promise<AgentAdapter> {
  const wanted = id ?? defaultAgentId();
  if (wanted === undefined) throw new UnknownAgentError(id ?? "default");
  const load = loaders.get(wanted);
  if (!load) throw new UnknownAgentError(wanted);
  return await load();
}

/** The seam the Task Runner depends on; tests substitute a fake registry. */
export interface AgentRegistry {
  resolve(id?: string): Promise<AgentAdapter>;
  list(): AgentInfo[];
}

export const agents: AgentRegistry = { resolve: resolveAgent, list: listAgents };
