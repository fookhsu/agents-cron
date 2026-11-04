import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import "../builtin.ts";
import { registerCommands } from "./commands.ts";
import { registerTools } from "./tools.ts";
import { ensureToolSearchActive } from "./tool-search.ts";
import { notifyUpdateOnce } from "./update-notice.ts";
import { LEGACY_TASK_SESSION_ENV, TASK_SESSION_ENV } from "./env.ts";

/**
 * Management surface only. The extension never schedules, locks, polls, or
 * executes: cron invokes `agents-cron run-due`, and this only reads/writes
 * the store. Inside a Task Session it stays completely inert.
 *
 * Set by whichever copy of this extension loads first in a runtime. The
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

  // `/reload`, `/new`, `/resume` and `/fork` replace the whole extension
  // runtime: pi re-imports this module in the same process (jiti runs with
  // `moduleCache: false`) and rebuilds every extension's command and tool
  // registry from scratch. globalThis survives that re-import while the
  // registrations do not, so a flag left set would make the replacement copy
  // load inert and /schedule, /loop, /remind and schedule_task would vanish
  // until the process restarts. Every runtime replacement is preceded by a
  // `session_shutdown`, so clearing there keeps the flag meaning "claimed by
  // this runtime" instead of "claimed by this process".
  pi.on("session_shutdown", () => {
    delete scope[LOADED_FLAG];
  });

  if (scope[LOADED_FLAG]) return;
  scope[LOADED_FLAG] = true;

  registerCommands(pi);
  registerTools(pi);

  // schedule_task is deferred-exposed; make sure the model can reach it
  // through tool_search. Runs after every extension has registered, so the
  // built-in tool_search tool exists by then. Idempotent per session start.
  // The same hook fires the one-time upgrade notice; fire-and-forget so the
  // notice never delays startup (update-notice.ts swallows its own errors).
  pi.on("session_start", (_event, ctx) => {
    ensureToolSearchActive(pi);
    void notifyUpdateOnce(ctx);
  });
}
