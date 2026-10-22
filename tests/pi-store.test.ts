import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { piSessionDirFor, taskSessionFileInPiStore } from "../src/agents/pi/pi-store.ts";

/**
 * The store contract mirrored here is Pi's own: sessions for a cwd live in
 * `<agentDir>/sessions/--<encoded-cwd>--/`, where the encoded name strips the
 * leading separator and replaces every `/`, `\`, and `:` with `-`. Expected
 * values below are hand-computed literals pinned to that contract
 * (pi-coding-agent dist/core/session-manager.js, getDefaultSessionDirPath) so
 * a drift in either side shows up as a red test.
 */

test("encodes a cwd into Pi's session directory name", () => {
  const dir = piSessionDirFor("/Users/dev/work/my-project", {
    PI_CODING_AGENT_DIR: "/store-root",
  });

  assert.equal(dir, join("/store-root", "sessions", "--Users-dev-work-my-project--"));
});

test("replaces every separator and colon in the encoded name", () => {
  const dir = piSessionDirFor("/Users/dev/a b/sub.dir", { PI_CODING_AGENT_DIR: "/store-root" });

  assert.equal(dir, join("/store-root", "sessions", "--Users-dev-a b-sub.dir--"));
});

test("falls back to the default agent dir under $HOME when no override is set", () => {
  const dir = piSessionDirFor("/Users/dev/work/my-project", {});

  assert.equal(dir, join(homedir(), ".pi", "agent", "sessions", "--Users-dev-work-my-project--"));
});

test("expands ~ in PI_CODING_AGENT_DIR the way Pi does", () => {
  const dir = piSessionDirFor("/Users/dev/work/my-project", { PI_CODING_AGENT_DIR: "~/pi-root" });

  assert.equal(dir, join(homedir(), "pi-root", "sessions", "--Users-dev-work-my-project--"));
});

test("PI_CODING_AGENT_SESSION_DIR is a flat override: no sessions/ join, no encoding", () => {
  const dir = piSessionDirFor("/Users/dev/work/my-project", {
    PI_CODING_AGENT_DIR: "/store-root",
    PI_CODING_AGENT_SESSION_DIR: "/flat/store",
  });

  assert.equal(dir, resolve("/flat/store"));
});

test("a task session in the store is a first-level file named after task and run", () => {
  const file = taskSessionFileInPiStore("/Users/dev/work/my-project", "task_1a2b3c4d", "run_20260929T075719Z_deadbeef", {
    PI_CODING_AGENT_DIR: "/store-root",
  });

  assert.equal(
    file,
    join("/store-root", "sessions", "--Users-dev-work-my-project--", "task_1a2b3c4d-run_20260929T075719Z_deadbeef.jsonl"),
    "first-level .jsonl (Pi's scanners do not recurse), taskId prefix keeps the run attributable",
  );
});

test("canonicalizes symlinked cwd components, like Pi's process.cwd() does", async () => {
  const real = await mkdtemp(join(tmpdir(), "agents-cron-real-"));
  const linked = join(real, "link-target");
  await mkdir(linked);
  const alias = join(real, "alias");
  await symlink("link-target", alias);
  try {
    const dir = piSessionDirFor(alias, { PI_CODING_AGENT_DIR: "/store-root" });

    assert.equal(
      dir,
      join("/store-root", "sessions", `--${realpathSync(linked).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`),
      "a cwd through a symlink lands in the real directory's session dir, matching the cwd pi will record",
    );
  } finally {
    await rm(real, { recursive: true, force: true });
  }
});
