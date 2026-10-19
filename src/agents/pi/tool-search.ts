import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * `schedule_task` has `exposure: "deferred"`: it stays out of the resident
 * tool manifest until the model finds it with pi's built-in `tool_search`.
 * That tool ships registered-but-inactive, so without a deferred MCP server
 * nothing ever activates it and our tool would be undiscoverable.
 *
 * Mirrors the MCP extension's discovery activation: on session_start, if
 * `tool_search` is registered and reachable, add it to the active set. Never
 * registers anything itself, and never touches user settings; if `tool_search`
 * is absent (older pi, SDK session without the extension), this is a no-op and
 * the deferred tool remains reachable from codemode scripts and `/schedule`.
 */
export function ensureToolSearchActive(pi: ExtensionAPI): void {
  const registered = pi.getAllTools();
  const isSearchable = registered.some(
    (tool) => tool.name === "tool_search" && tool.reachesTools !== undefined,
  );
  if (!isSearchable) return;

  const active = pi.getActiveTools();
  if (!active.includes("tool_search")) pi.setActiveTools([...active, "tool_search"]);
}
