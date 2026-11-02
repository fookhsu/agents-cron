import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  dashboardStateFile,
  dashboardStatus,
  isPidAlive,
  probeDashboard,
  readDashboardState,
  startDetachedDashboard,
  stopDashboard,
  writeDashboardState,
  type DashboardState,
} from "../src/dashboard/lifecycle.ts";

// The dashboard reads the machine-wide registry, so every test points it at a
// throwaway home — the real ~/.agents/cron must never be touched.
let restoreHome: (() => void) | undefined;
before(async () => {
  const home = await mkdtemp(join(tmpdir(), "agents-cron-dash-home-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  restoreHome = () => {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
  };
});
after(() => restoreHome?.());

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agents-cron-dash-life-"));
}

const DEAD_PID = 999_999_999;

function state(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    pid: DEAD_PID,
    port: 7383,
    url: "http://127.0.0.1:7383/",
    startedAt: "2026-11-02T09:00:00.000Z",
    ...overrides,
  };
}

/** A server that is alive but answers nothing like the dashboard. */
async function impostor(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not the dashboard");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0 };
}

test("a project with no registration is neither running nor stale", async () => {
  const dir = await project();
  try {
    assert.deepEqual(await dashboardStatus(dir), { running: false, stale: false });
    assert.equal(await readDashboardState(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed registration is removed instead of trusted", async () => {
  const dir = await project();
  try {
    const file = dashboardStateFile(dir);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{ this is not json");

    assert.deepEqual(await dashboardStatus(dir), { running: false, stale: false });
    assert.equal(existsSync(file), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a dead pid makes the registration stale, and stop reports stale", async () => {
  const dir = await project();
  try {
    await writeDashboardState(dir, state());
    assert.deepEqual(await dashboardStatus(dir), { running: false, stale: true });
    assert.equal(existsSync(dashboardStateFile(dir)), false);

    await writeDashboardState(dir, state());
    assert.deepEqual(await stopDashboard(dir), { outcome: "stale" });
    assert.equal(existsSync(dashboardStateFile(dir)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stop refuses an alive pid whose port does not answer like the dashboard", async () => {
  const dir = await project();
  const fake = await impostor();
  try {
    const registered = state({ pid: process.pid, port: fake.port, url: `http://127.0.0.1:${fake.port}/` });
    await writeDashboardState(dir, registered);

    const result = await stopDashboard(dir);
    assert.equal(result.outcome, "refused");
    assert.deepEqual(result.state, registered);
    // The process is ours and still alive — a refusal must never signal it.
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(existsSync(dashboardStateFile(dir)), true);
  } finally {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("start registers a detached dashboard that answers, and stop reclaims it", async () => {
  const dir = await project();
  let pid: number | undefined;
  try {
    const started = await startDetachedDashboard(dir);
    pid = started.state.pid;

    assert.equal((await readDashboardState(dir))?.pid, pid);
    assert.equal(await probeDashboard(started.state.url), true);
    assert.deepEqual(await dashboardStatus(dir), { running: true, state: started.state, healthy: true });

    const stopped = await stopDashboard(dir);
    assert.equal(stopped.outcome, "stopped");
    assert.equal(stopped.state?.pid, pid);
    assert.equal(isPidAlive(pid), false);
    assert.equal(existsSync(dashboardStateFile(dir)), false);
  } finally {
    if (pid !== undefined && isPidAlive(pid)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
