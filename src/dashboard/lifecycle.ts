import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../fs-utils.ts";
import { schedulerPaths } from "../paths.ts";

/**
 * A detached dashboard outlives the terminal that started it (and the Pi
 * session that asked for it), so something has to remember which process is
 * serving which project. That is this file: one registration per project,
 * owned explicitly — start writes it, stop removes it, a dead pid makes it
 * stale and self-healing. Nothing kills the dashboard on session shutdown.
 */
export type DashboardState = {
  pid: number;
  port: number;
  url: string;
  startedAt: string;
};

/** Poll interval while a fresh child reports its registration. */
const STATE_POLL_MS = 150;
/** A TypeScript loader startup plus a listen should take well under this. */
const STATE_REPORT_TIMEOUT_MS = 10_000;
/** How long SIGTERM gets before SIGKILL, and SIGKILL before we give up. */
const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 1_000;

export function dashboardStateFile(projectDir: string): string {
  return join(schedulerPaths(projectDir).dir, "dashboard.json");
}

/** Where a detached dashboard's stdout and stderr go; it has no terminal. */
export function logFile(projectDir: string): string {
  return join(schedulerPaths(projectDir).dir, "dashboard.log");
}

/** The recorded registration, or undefined — a record we cannot read is stale by definition. */
export async function readDashboardState(projectDir: string): Promise<DashboardState | undefined> {
  const file = dashboardStateFile(projectDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isDashboardState(parsed)) return parsed;
  } catch {
    // Fall through: malformed means stale, and stale means remove.
  }
  await rm(file, { force: true }).catch(() => undefined);
  return undefined;
}

export async function writeDashboardState(projectDir: string, state: DashboardState): Promise<void> {
  await mkdir(dirname(dashboardStateFile(projectDir)), { recursive: true });
  await writeJsonAtomic(dashboardStateFile(projectDir), state);
}

/**
 * Removes the registration only if it still names `pid`, so a shutting-down
 * dashboard never erases a newer one that took its place.
 */
export async function removeDashboardState(projectDir: string, pid: number): Promise<void> {
  const state = await readDashboardState(projectDir);
  if (!state || state.pid !== pid) return;
  await rm(dashboardStateFile(projectDir), { force: true });
}

/** Signal 0 probes existence; EPERM means someone else's live process. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True only when the URL answers like this dashboard: HTTP 200 and an
 * overview bearing a `generatedAt` timestamp. Anything else — a timeout, a
 * connection refusal, another server on a recycled port — is not ours.
 */
export async function probeDashboard(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(new URL("api/overview", url), { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return false;
    const body = (await response.json()) as { generatedAt?: unknown };
    return typeof body?.generatedAt === "string";
  } catch {
    return false;
  }
}

/** The lifecycle view: registered and alive, or not — with health when it is. */
export async function dashboardStatus(
  projectDir: string,
): Promise<{ running: true; state: DashboardState; healthy: boolean } | { running: false; stale: boolean }> {
  const state = await readDashboardState(projectDir);
  if (!state) return { running: false, stale: false };
  if (!isPidAlive(state.pid)) {
    await rm(dashboardStateFile(projectDir), { force: true }).catch(() => undefined);
    return { running: false, stale: true };
  }
  return { running: true, state, healthy: await probeDashboard(state.url) };
}

/**
 * Starts the dashboard as a detached child and waits for its registration.
 * An already-running healthy dashboard is reused rather than duplicated.
 */
export async function startDetachedDashboard(
  projectDir: string,
  port = 0,
): Promise<{ state: DashboardState }> {
  const status = await dashboardStatus(projectDir);
  if (status.running && status.healthy) return { state: status.state };

  const log = logFile(projectDir);
  await mkdir(dirname(log), { recursive: true }).catch(() => undefined);
  const logHandle = openLog(log);

  const child = spawn(
    process.execPath,
    [cliBin(), "dashboard", "--port", String(port), "--project", projectDir],
    { detached: true, stdio: ["ignore", logHandle, logHandle], env: process.env },
  );
  if (typeof logHandle === "number") closeSync(logHandle);
  child.unref();

  if (child.pid === undefined) throw new Error("dashboard did not start");

  const deadline = Date.now() + STATE_REPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readDashboardState(projectDir);
    if (state?.pid === child.pid) return { state };
    await sleep(STATE_POLL_MS);
  }

  // The child never reported; it is of no use to anyone, so do not leave it.
  child.kill("SIGKILL");
  throw new Error("dashboard did not report its state");
}

/**
 * Stops the registered dashboard after checking it is really ours: a live
 * pid whose port does not answer like the dashboard is probably PID reuse,
 * and killing an unverified process is never worth it.
 */
export async function stopDashboard(
  projectDir: string,
): Promise<{ outcome: "stopped" | "stale" | "not-running" | "refused"; state?: DashboardState }> {
  const status = await dashboardStatus(projectDir);
  if (!status.running) return { outcome: status.stale ? "stale" : "not-running" };

  const { state } = status;
  if (!status.healthy) return { outcome: "refused", state };

  kill(state.pid, "SIGTERM");
  if (!(await waitForExit(state.pid, TERM_GRACE_MS))) {
    kill(state.pid, "SIGKILL");
    await waitForExit(state.pid, KILL_GRACE_MS);
  }
  // Pid-guarded, not unconditional: the identity was verified above, but a
  // fresh dashboard may have re-registered in the window since.
  await removeDashboardState(projectDir, state.pid);
  return { outcome: "stopped", state };
}

/** An append fd for the log, or "ignore" when the store is not writable. */
function openLog(log: string): number | "ignore" {
  try {
    return openSync(log, "a");
  } catch {
    return "ignore";
  }
}

/** The CLI that runs this package's TypeScript sources, as a detached child. */
function cliBin(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "agents-cron.mjs");
}

function isDashboardState(value: unknown): value is DashboardState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DashboardState>;
  return (
    typeof state.pid === "number" &&
    Number.isInteger(state.pid) &&
    state.pid > 0 &&
    typeof state.port === "number" &&
    typeof state.url === "string" &&
    typeof state.startedAt === "string"
  );
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone: the caller's polling confirms it.
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
