/**
 * Pi loads this file as the package's extension entry (pi.extensions).
 * The entry file must be named `index.*` at the package root: pi's compact
 * label logic (getCompactExtensionLabel) only drops the file path when the
 * entry basename is `index`, otherwise it shows `agents-cron:extension.mjs`
 * instead of just `agents-cron`. The real management surface lives in
 * src/agents/pi/ alongside its commands, tools, and env pieces; this file
 * only re-exports it.
 */
import extension from "./src/agents/pi/extension.ts";

export default extension;
