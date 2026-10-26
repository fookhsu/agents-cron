import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compareVersions,
  extractChangelog,
  notifyUpdateOnce,
  readOwnVersion,
  updateNoticeMessage,
  type NoticeContext,
} from "../src/agents/pi/update-notice.ts";
import { registryPaths } from "../src/paths.ts";

const SAMPLE_CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Something not shipped yet",
  "",
  "## [0.11.0] - 2026-11-01",
  "",
  "### Added",
  "",
  "- Update notices in the Pi terminal",
  "",
  "### Fixed",
  "",
  "- A bug",
  "",
  "## [0.10.3] - 2026-10-28",
  "",
  "### Fixed",
  "",
  "- Another bug",
  "",
  "## [0.10.2] - 2026-10-23",
  "",
  "### Added",
  "",
  "- migrate-sessions",
  "",
].join("\n");

function stubCtx(hasUI = true): { ctx: NoticeContext; notices: string[] } {
  const notices: string[] = [];
  return { notices, ctx: { hasUI, ui: { notify: (message: string) => notices.push(message) } } };
}

test("compareVersions orders numerically and rejects garbage", () => {
  assert.ok(compareVersions("0.9.9", "0.10.0") < 0);
  assert.ok(compareVersions("0.10.0", "0.10.0") === 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.ok(Number.isNaN(compareVersions("banana", "0.10.0")));
});

test("extractChangelog: first run shows only the running version", () => {
  const out = extractChangelog(SAMPLE_CHANGELOG, undefined, "0.11.0");
  assert.match(out!, /^v0\.11\.0$/m);
  assert.match(out!, /Update notices/);
  assert.doesNotMatch(out!, /0\.10\.3/);
  assert.doesNotMatch(out!, /not shipped yet/);
});

test("extractChangelog: an upgrade spans every section in (from, to]", () => {
  const out = extractChangelog(SAMPLE_CHANGELOG, "0.10.2", "0.11.0");
  assert.match(out!, /^v0\.11\.0$/m);
  assert.match(out!, /^v0\.10\.3$/m);
  assert.doesNotMatch(out!, /v0\.10\.2/);
  assert.doesNotMatch(out!, /migrate-sessions/);
  assert.doesNotMatch(out!, /not shipped yet/);
});

test("extractChangelog: nothing matches when from === to", () => {
  assert.equal(extractChangelog(SAMPLE_CHANGELOG, "0.11.0", "0.11.0"), undefined);
});

test("extractChangelog reformats markdown headings for plain-text notify", () => {
  const out = extractChangelog(SAMPLE_CHANGELOG, undefined, "0.10.3")!;
  assert.match(out, /Fixed:/);
  assert.doesNotMatch(out, /###/);
});

test("updateNoticeMessage: same version and downgrades stay quiet", () => {
  assert.equal(updateNoticeMessage({ current: "0.11.0", seen: "0.11.0", changelog: SAMPLE_CHANGELOG }), undefined);
  assert.equal(updateNoticeMessage({ current: "0.10.2", seen: "0.11.0", changelog: SAMPLE_CHANGELOG }), undefined);
});

test("updateNoticeMessage: an upgrade announces both versions and the changes", () => {
  const out = updateNoticeMessage({ current: "0.11.0", seen: "0.10.2", changelog: SAMPLE_CHANGELOG })!;
  assert.match(out, /^agents-cron updated 0\.10\.2 → 0\.11\.0$/m);
  assert.match(out, /Update notices in the Pi terminal/);
  assert.match(out, /\/schedule changelog/);
});

test("updateNoticeMessage: a missing changelog falls back to the releases page", () => {
  const out = updateNoticeMessage({ current: "0.11.0", seen: "0.10.2" })!;
  assert.match(out, /https:\/\/github\.com\/fookhsu\/agents-cron\/releases/);
});

test("updateNoticeMessage: first run reads as an introduction, not an upgrade", () => {
  const out = updateNoticeMessage({ current: "0.11.0", changelog: SAMPLE_CHANGELOG })!;
  assert.match(out, /^agents-cron 0\.11\.0$/m);
  assert.doesNotMatch(out, /updated/);
});

test("notifyUpdateOnce: notifies once per upgrade, then stays quiet", async () => {
  const { ctx, notices } = stubCtx();
  await notifyUpdateOnce(ctx);
  assert.equal(notices.length, 1, "first run notifies");

  const { stateFile } = registryPaths();
  assert.ok(existsSync(stateFile), "marker written");
  assert.equal(
    JSON.parse(readFileSync(stateFile, "utf8")).seenVersion,
    await readOwnVersion(),
  );

  await notifyUpdateOnce(ctx);
  assert.equal(notices.length, 1, "same version stays quiet");
});

test("notifyUpdateOnce: an older marker re-announces the upgrade", async () => {
  const { stateFile } = registryPaths();
  seedMarker(stateFile, "0.0.1");

  const { ctx, notices } = stubCtx();
  await notifyUpdateOnce(ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0], new RegExp(`updated 0\\.0\\.1 → ${await readOwnVersion()}`));
});

test("notifyUpdateOnce: a newer marker (downgrade) stays quiet and untouched", async () => {
  const { stateFile } = registryPaths();
  seedMarker(stateFile, "99.0.0");

  const { ctx, notices } = stubCtx();
  await notifyUpdateOnce(ctx);
  assert.equal(notices.length, 0);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).seenVersion, "99.0.0");
});

test("notifyUpdateOnce: no UI channel means no notice and no marker", async () => {
  const { ctx, notices } = stubCtx(false);
  await notifyUpdateOnce(ctx);
  assert.equal(notices.length, 0);
  assert.ok(!existsSync(registryPaths().stateFile));
});

// The machine-wide store is redirected for the whole file; each test starts
// without a marker unless it seeds one, so notices fire exactly once per test.
function seedMarker(stateFile: string, seenVersion: string): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ version: 1, seenVersion }));
}

const home = mkdtempSync(join(tmpdir(), "agents-cron-update-notice-"));
const previousHome = process.env.AGENTS_CRON_HOME;
process.env.AGENTS_CRON_HOME = home;

test.beforeEach(() => {
  rmSync(join(home, ".agents"), { recursive: true, force: true });
});

test.after(() => {
  if (previousHome !== undefined) process.env.AGENTS_CRON_HOME = previousHome;
  else delete process.env.AGENTS_CRON_HOME;
  rmSync(home, { recursive: true, force: true });
});
