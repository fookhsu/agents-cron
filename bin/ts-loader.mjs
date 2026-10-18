/**
 * Type-stripping loader for this package's own `.ts` sources.
 *
 * Node strips types for `.ts` files everywhere except under `node_modules`,
 * which is exactly where an installed package lives. Pi's extension loader
 * does not care (it compiles TypeScript itself through jiti), but the CLI
 * runs under a bare `node` from cron, so it needs this hook to run the same
 * sources.
 *
 * Two rules keep this hook polite:
 *
 * - It only touches `.ts` files inside this package's own directory, resolved
 *   through the symlink a package manager may put in front of `bin/`. Every
 *   other specifier — including any other package's TypeScript — falls through
 *   to Node and to whatever hooks the host process registered.
 * - Stripping is `mode: "strip"`, so the sources must stay erasable;
 *   `erasableSyntaxOnly` in `tsconfig.json` enforces that at typecheck time,
 *   which is what keeps this loader from being a runtime surprise.
 */
import { readFile, realpath } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// This package's root directory as a `file:` URL with a trailing slash, so a
// plain startsWith() decides whether a URL belongs to us.
const packageRoot = `${pathToFileURL(
  await realpath(fileURLToPath(new URL("../", import.meta.url))),
).href}/`;

/**
 * `stripTypeScriptTypes` is experimental and warns on first use. The warning
 * would come from this hook, so mute exactly that one and only while
 * stripping — harnesses that spawn this CLI read its stderr, and a stray
 * ExperimentalWarning reads like a failure. Everything else keeps Node's
 * default treatment, and the override never outlives the call.
 */
function strip(source, url) {
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = (warning, ...rest) =>
      String(warning).includes("stripTypeScriptTypes")
        ? undefined
        : emitWarning.call(process, warning, ...rest);
    return stripTypeScriptTypes(source, { mode: "strip", sourceUrl: url });
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** @type {import("node:module").LoadHook} */
export async function load(url, context, nextLoad) {
  if (
    !url.startsWith("file:") ||
    !url.endsWith(".ts") ||
    !url.startsWith(packageRoot)
  ) {
    return nextLoad(url, context);
  }

  const source = await readFile(new URL(url), "utf8");
  return {
    format: "module",
    source: strip(source, url),
    shortCircuit: true,
  };
}
