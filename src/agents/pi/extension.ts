import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import "../builtin.ts";
import { registerCommands } from "./commands.ts";
import { registerTools } from "./tools.ts";
import { ensureToolSearchActive } from "./tool-search.ts";
import { LEGACY_TASK_SESSION_ENV, TASK_SESSION_ENV } from "./env.ts";

/**
 * Management surface only. The extension never schedules, locks, polls, or
 * executes: cron invokes `agents-cron run-due`, and this only reads/writes
 * the store. Inside a Task Session it stays completely inert.
 *
 * Set by whichever copy of this extension loads first in a process. The
 * pre-rename @fookhsu/pi-scheduler shim forwards this same extension, so
 * during migration both packages can be installed at once and pi would load
 * two copies that fight over the same tool and command names. `Symbol.for`
 * is shared across module instances, so the second copy sees the flag and
 * stays inert no matter which package path loaded first. Both copies run
 * this same file, so the user loses nothing.
 */
const LOADED_FLAG = Symbol.for("agents-cron.extension.loaded");

export default function (pi: ExtensionAPI): void {
  if (process.env[TASK_SESSION_ENV] ?? process.env[LEGACY_TASK_SESSION_ENV]) return;

  const scope = globalThis as Record<symbol, boolean>;
  if (scope[LOADED_FLAG]) return;
  scope[LOADED_FLAG] = true;

  registerCommands(pi);
  registerTools(pi);

  // schedule_task is deferred-exposed; make sure the model can reach it
  // through tool_search. Runs after every extension has registered, so the
  // built-in tool_search tool exists by then. Idempotent per session start.
  pi.on("session_start", () => ensureToolSearchActive(pi));
}
