import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratePiSessions } from "../src/agents/pi/migrate.ts";
import { schedulerPaths } from "../src/paths.ts";
import { readRun, writeRun } from "../src/runs.ts";
import type { RunRecord } from "../src/types.ts";

// Every test runs against a throwaway Task Registry (like the CLI tests), so
// the machine's real registry never answers a cwd fallback.
let restoreHome: (() => void) | undefined;
test.before(async () => {
  const home = await mkdtemp(join(tmpdir(), "agents-cron-home-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  restoreHome = () => {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
  };
});
test.after(() => restoreHome?.());

/**
 * migrate-sessions carries legacy private-layout transcripts into Pi's default
 * session store and rewrites each run record to point there. The store root is
 * pinned per test with PI_CODING_AGENT_DIR so nothing touches the real
 * ~/.pi/agent.
 */

async function seed(): Promise<{ project: string; store: string; run: RunRecord }> {
  const project = await mkdtemp(join(tmpdir(), "agents-cron-mig-"));
  const store = await mkdtemp(join(tmpdir(), "agents-cron-store-"));
  return { project, store, run: await seedPiRun(project) };
}

/** A finished pi run with its transcript in the legacy private layout. */
async function seedPiRun(
  project: string,
  overrides: Partial<RunRecord> = {},
): Promise<RunRecord> {
  const run: RunRecord = {
    runId: "run_20261022T120000Z_c0ffee",
    taskId: "task_1a2b3c4d",
    trigger: "scheduled",
    startedAt: "2026-10-22T12:00:00.000Z",
    status: "success",
    finishedAt: "2026-10-22T12:01:00.000Z",
    exitCode: 0,
    ...overrides,
  };
  const legacy = join(schedulerPaths(project).sessionsDir, run.taskId, `${run.runId}.jsonl`);
  await mkdir(join(legacy, ".."), { recursive: true });
  await writeFile(legacy, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: run.startedAt, cwd: project })}\n`);
  await chmod(legacy, 0o600);
  await writeRun(schedulerPaths(project).runsDir, { ...run, sessionFile: legacy });
  return run;
}

function storeEnv(store: string): NodeJS.ProcessEnv {
  return { PI_CODING_AGENT_DIR: store };
}

async function cleanup(project: string, store: string): Promise<void> {
  await rm(project, { recursive: true, force: true });
  await rm(store, { recursive: true, force: true });
}

test("moves a legacy pi transcript into the store and rewrites the record", async () => {
  const { project, store, run } = await seed();
  try {
    const report = await migratePiSessions({ projectDir: project, env: storeEnv(store) });

    const encoded = `--${realpathSync(project).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const target = join(store, "sessions", encoded, `${run.taskId}-${run.runId}.jsonl`);

    assert.deepEqual(report.moves.map((move) => move.runId), [run.runId]);
    assert.equal(report.moves[0].to, target);

    const content = await readFile(target, "utf8");
    assert.match(content, /"type":"session"/);
    assert.equal((await stat(target)).mode & 0o777, 0o600, "the transcript keeps its 0600 permissions");

    const legacy = join(schedulerPaths(project).sessionsDir, run.taskId, `${run.runId}.jsonl`);
    await assert.rejects(() => stat(legacy), { code: "ENOENT" }, "the legacy file is gone");
    await assert.rejects(
      () => stat(schedulerPaths(project).sessionsDir),
      { code: "ENOENT" },
      "the now-empty legacy sessions directory is removed",
    );

    const record = await readRun(schedulerPaths(project).runsDir, run.runId);
    assert.equal(record?.sessionFile, target, "the run record points at the store");
  } finally {
    await cleanup(project, store);
  }
});

test("a second pass is a no-op: the record already points into the store", async () => {
  const { project, store, run } = await seed();
  try {
    await migratePiSessions({ projectDir: project, env: storeEnv(store) });
    const second = await migratePiSessions({ projectDir: project, env: storeEnv(store) });

    assert.deepEqual(second.moves, []);
    assert.deepEqual(second.relinks, []);
    assert.deepEqual(second.skips, [{ runId: run.runId, reason: "already migrated" }]);
  } finally {
    await cleanup(project, store);
  }
});

test("skips other agents' runs and runs without any transcript", async () => {
  const { project, store } = await seed();
  try {
    await seedPiRun(project, { runId: "run_20261022T120100Z_claude1", agent: "claude" });
    const noFile = await seedPiRun(project, {
      runId: "run_20261022T120200Z_nofile1",
      status: "error",
      exitCode: 1,
      error: "pi exited with 1",
    });
    // An errored run may have no transcript at all; drop the seeded one.
    await rm(join(schedulerPaths(project).sessionsDir, noFile.taskId, `${noFile.runId}.jsonl`), { force: true });

    const report = await migratePiSessions({ projectDir: project, env: storeEnv(store) });

    const byRun = new Map(report.skips.map((skip) => [skip.runId, skip.reason]));
    assert.equal(byRun.get("run_20261022T120100Z_claude1"), "agent claude");
    assert.equal(byRun.get("run_20261022T120200Z_nofile1"), "no transcript");
  } finally {
    await cleanup(project, store);
  }
});

test("relinks a stale record when the transcript already sits in the store", async () => {
  const { project, store, run } = await seed();
  try {
    const first = await migratePiSessions({ projectDir: project, env: storeEnv(store) });
    const target = first.moves[0].to;
    // Simulate a record restored from backup: file in the store, record still
    // pointing at the legacy layout.
    const legacy = join(schedulerPaths(project).sessionsDir, run.taskId, `${run.runId}.jsonl`);
    await writeRun(schedulerPaths(project).runsDir, { ...run, sessionFile: legacy });

    const report = await migratePiSessions({ projectDir: project, env: storeEnv(store) });

    assert.deepEqual(report.moves, []);
    assert.deepEqual(report.relinks, [{ runId: run.runId, to: target }]);
    const record = await readRun(schedulerPaths(project).runsDir, run.runId);
    assert.equal(record?.sessionFile, target);
  } finally {
    await cleanup(project, store);
  }
});

test("derives the store directory from the session header's cwd, even when the task is gone", async () => {
  const { project, store } = await seed();
  try {
    const sub = join(project, "sub");
    await mkdir(sub, { recursive: true });
    // Header says the run worked in <project>/sub; no tasks.json entry exists.
    const run = await seedPiRun(project);
    const legacy = join(schedulerPaths(project).sessionsDir, run.taskId, `${run.runId}.jsonl`);
    await writeFile(legacy, `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: run.startedAt, cwd: sub })}\n`);

    const report = await migratePiSessions({ projectDir: project, env: storeEnv(store) });

    const encoded = `--${realpathSync(sub).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    assert.equal(report.moves[0].to, join(store, "sessions", encoded, `${run.taskId}-${run.runId}.jsonl`));
  } finally {
    await cleanup(project, store);
  }
});

test("falls back to the task's cwd when the transcript has no readable header", async () => {
  const { project, store } = await seed();
  try {
    const run = await seedPiRun(project);
    await writeFile(join(schedulerPaths(project).sessionsDir, run.taskId, `${run.runId}.jsonl`), "");
    const { saveRegistry } = await import("../src/registry.ts");
    await saveRegistry([
      {
        id: run.taskId,
        projectDir: project,
        prompt: "check the CI",
        schedule: { kind: "interval", everyMs: 1_800_000 },
        cwd: "subdir",
        enabled: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ] as never);

    const report = await migratePiSessions({ projectDir: project, env: storeEnv(store) });

    const encoded = `--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}-subdir--`;
    assert.equal(report.moves[0].to, join(store, "sessions", encoded, `${run.taskId}-${run.runId}.jsonl`));
  } finally {
    await cleanup(project, store);
  }
});

test("dry-run reports the move but touches nothing", async () => {
  const { project, store, run } = await seed();
  try {
    const report = await migratePiSessions({ projectDir: project, env: storeEnv(store), dryRun: true });

    assert.equal(report.moves.length, 1);
    const legacy = join(schedulerPaths(project).sessionsDir, run.taskId, `${run.runId}.jsonl`);
    await stat(legacy); // still there
    const record = await readRun(schedulerPaths(project).runsDir, run.runId);
    assert.equal(record?.sessionFile, legacy, "the record is untouched");
  } finally {
    await cleanup(project, store);
  }
});

test("removes the legacy task directory once it is empty, keeps it when it is not", async () => {
  const { project, store } = await seed();
  try {
    const run = await seedPiRun(project, {
      runId: "run_20261022T120300Z_leftov1",
      agent: "claude",
    });
    // The claude seed wrote a .jsonl legacy file; swap it to .json so the run
    // is skipped and the directory must survive with the leftover inside.
    const legacyDir = join(schedulerPaths(project).sessionsDir, run.taskId);
    await rm(join(legacyDir, `${run.runId}.jsonl`), { force: true });
    await writeFile(join(legacyDir, `${run.runId}.json`), "{}");

    const report = await migratePiSessions({ projectDir: project, env: storeEnv(store) });

    assert.equal(report.skips[0]?.reason, "agent claude");
    await stat(legacyDir); // kept: still holds the claude transcript
    await stat(join(legacyDir, `${run.runId}.json`));
  } finally {
    await cleanup(project, store);
  }
});
