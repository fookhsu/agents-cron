import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../../fs-utils.ts";
import { registryPaths } from "../../paths.ts";

/**
 * Update notices. Pi has no package-update surface of its own — `pi update
 * --extensions` only reconciles installations — so the extension reports its
 * own upgrades. On session_start it compares the running package version
 * against a marker in the machine-wide store (`~/.agents/cron/`), and when
 * the version moved forward it shows the CHANGELOG.md sections in between
 * as one notify() call.
 *
 * Everything here is best-effort: a notice is advertising, so any failure
 * (missing changelog, unreadable marker, no UI) stays silent and must never
 * break session start or the store.
 */

/** Structural slice of ExtensionContext, so tests can stub the UI. */
export type NoticeContext = {
  hasUI: boolean;
  ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
};

const STATE_VERSION = 1;

type ExtensionStateFile = { version: 1; seenVersion: string };

/** Cap the notice body; longer changelogs point at /schedule changelog. */
const MAX_NOTICE_LINES = 25;

const RELEASES_URL = "https://github.com/fookhsu/agents-cron/releases";

/**
 * Compare two `x.y.z` versions numerically. Anything unparseable compares
 * as NaN; callers treat NaN as "unknown" rather than ordering it.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseTriple(a);
  const pb = parseTriple(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parseTriple(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

type ChangelogSection = { version: string; lines: string[] };

/**
 * Split a Keep-a-Changelog file into its versioned sections, in file order
 * (newest first by convention). Non-version headings such as `## [Unreleased]`
 * end the previous section and have their bodies skipped: an Unreleased body
 * describes changes that no installed version contains yet.
 */
function parseChangelogSections(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
    if (match) {
      current = { version: match[1], lines: [] };
      sections.push(current);
    } else if (current && /^## /.test(line)) {
      current = undefined;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

/**
 * The changelog body for `from → to`, or undefined when no section matches.
 * `from === undefined` means the marker never ran before (fresh install or
 * pre-notice upgrade): only the running version's section is shown, once.
 */
export function extractChangelog(text: string, from: string | undefined, to: string): string | undefined {
  const wanted = parseChangelogSections(text).filter((section) => {
    if (compareVersions(section.version, to) > 0) return false;
    if (from === undefined) return compareVersions(section.version, to) === 0;
    return compareVersions(section.version, from) > 0;
  });
  if (wanted.length === 0) return undefined;
  return wanted.map((section) => [`v${section.version}`, ...reformatBody(section.lines)].join("\n")).join("\n\n");
}

/** `### Added` becomes `Added:`; notify() renders plain text, not markdown. */
function reformatBody(lines: string[]): string[] {
  const body = lines.map((line) => line.replace(/^###\s+(.+?)\s*$/, "$1:"));
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  return body;
}

/**
 * Pure decision: the notice text for this state transition, or undefined
 * when nothing should be shown (same version, downgrade, or an unparseable
 * marker, which is treated as a first run inside the message builder).
 */
export function updateNoticeMessage(input: {
  current: string;
  seen?: string;
  changelog?: string;
}): string | undefined {
  const seen = input.seen !== undefined && Number.isNaN(compareVersions(input.seen, input.current))
    ? undefined
    : input.seen;
  if (seen !== undefined && compareVersions(seen, input.current) >= 0) return undefined;

  const header = seen === undefined
    ? `agents-cron ${input.current}`
    : `agents-cron updated ${seen} → ${input.current}`;
  const extracted = extractChangelog(input.changelog ?? "", seen, input.current);
  const body = extracted
    ? capLines(extracted, MAX_NOTICE_LINES)
    : `Changes: ${RELEASES_URL}`;
  return `${header}\n\n${body}\n\n/schedule changelog shows the full history.`;
}

function capLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n…`;
}

async function readTextIfExists(url: URL): Promise<string | undefined> {
  try {
    return await readFile(url, "utf8");
  } catch {
    return undefined;
  }
}

/** The version of the package this module is installed in. */
export async function readOwnVersion(): Promise<string | undefined> {
  const text = await readTextIfExists(new URL("../../../package.json", import.meta.url));
  if (text === undefined) return undefined;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The changelog shipped beside this module (package.json `files`). */
export async function readOwnChangelog(): Promise<string | undefined> {
  return readTextIfExists(new URL("../../../CHANGELOG.md", import.meta.url));
}

async function readSeenVersion(stateFile: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as Partial<ExtensionStateFile>;
    return parsed.version === STATE_VERSION && typeof parsed.seenVersion === "string"
      ? parsed.seenVersion
      : undefined;
  } catch {
    return undefined; // missing or corrupt: same as never having run
  }
}

/**
 * Show the update notice at most once per upgrade. Called from
 * session_start; failures are swallowed by design.
 */
export async function notifyUpdateOnce(ctx: NoticeContext): Promise<void> {
  try {
    if (!ctx.hasUI) return; // json/print modes have no notify channel

    const current = await readOwnVersion();
    if (current === undefined) return;

    const { stateFile } = registryPaths();
    const seenRaw = await readSeenVersion(stateFile);
    const seen = seenRaw !== undefined && Number.isNaN(compareVersions(seenRaw, current))
      ? undefined
      : seenRaw;
    if (seen !== undefined && compareVersions(seen, current) >= 0) return; // same or newer: quiet

    const message = updateNoticeMessage({ current, seen, changelog: await readOwnChangelog() });
    if (message === undefined) return; // unreachable here (seen < current), but keeps the types honest
    ctx.ui.notify(message, "info");

    // Advance the marker after notifying. A failed write only means the
    // notice repeats next session; a downgrade leaves the marker untouched
    // so returning to the newer version stays quiet.
    await writeJsonAtomic(stateFile, { version: STATE_VERSION, seenVersion: current } satisfies ExtensionStateFile);
  } catch {
    // Advertising must never break a session start.
  }
}
