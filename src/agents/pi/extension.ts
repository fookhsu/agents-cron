import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import "../builtin.ts";
import { registerCommands } from "./commands.ts";
import { registerTools } from "./tools.ts";
import { LEGACY_TASK_SESSION_ENV, TASK_SESSION_ENV } from "./env.ts";

/**
 * Management surface only. The extension never schedules, locks, polls, or
 * executes: cron invokes `agents-cron run-due`, and this only reads/writes the
 * store. Inside a Task Session it stays completely inert.
 */
export default function (pi: ExtensionAPI): void {
  if (process.env[TASK_SESSION_ENV] ?? process.env[LEGACY_TASK_SESSION_ENV]) return;

  registerCommands(pi);
  registerTools(pi);
}
