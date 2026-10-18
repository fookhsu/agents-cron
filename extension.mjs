/**
 * Pi loads this file as the package's extension entry (pi.extensions), so the
 * resource label pi shows stays short: `agents-cron:extension.mjs`. The real
 * management surface lives in src/agents/pi/ alongside its commands, tools,
 * and env pieces; this file only re-exports it.
 */
import extension from "./src/agents/pi/extension.ts";

export default extension;
