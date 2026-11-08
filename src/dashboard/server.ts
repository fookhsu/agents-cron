import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "../errors.ts";
import { schedulerPaths } from "../paths.ts";
import { loadRegistry } from "../registry.ts";
import { findTask } from "../runner.ts";
import { listRuns, listRunsForTask, readRun } from "../runs.ts";
import { listTasks } from "../task-service.ts";
import type { RunRecord, ScheduleTask } from "../types.ts";
import { dashboardPage } from "./page.ts";

/** The default port for `agents-cron dashboard`. 7383 = "sdh" on a keypad. */
export const DEFAULT_DASHBOARD_PORT = 7383;

/** Session records are capped when served; larger transcripts are tailed. */
const MAX_SESSION_BYTES = 512 * 1024;

export type DashboardHandle = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

export type TaskOverview = ScheduleTask & { latestRun?: RunRecord };

/**
 * The dashboard answers machine-readably for the same reason the CLI does: an
 * agent drives it with `curl`, and a truncated run list or an error string
 * with no code forces it to read prose to find out what happened.
 *
 *   /api/overview  the global view plus its aggregates
 *   /api/runs      one page of one task's history, with the total behind it
 *   errors         `{error: {code, message}}` on any non-2xx
 */
export type OverviewResponse = {
  generatedAt: string;
  total: number;
  enabled: number;
  /** Tasks whose latest run, or latest recorded status, is an error. */
  failures: number;
  tasks: TaskOverview[];
};

export type RunsResponse = {
  taskId: string;
  /** Every run this task has, not just the page returned. */
  total: number;
  returned: number;
  has_more: boolean;
  /** The limit that would return everything, when truncated. */
  next_limit?: number;
  runs: RunRecord[];
};

export type ErrorResponse = { error: { code: string; message: string } };

/**
 * A read-only, localhost-only dashboard over the project's scheduler store.
 * It starts on demand (`agents-cron dashboard`), serves JSON from the same
 * files the CLI reads, and never mutates anything — so it needs no run lock
 * and coexists with cron's `run-due`.
 */
export async function startDashboard(options: {
  projectDir: string;
  port?: number;
  host?: string;
}): Promise<DashboardHandle> {
  const host = options.host ?? "127.0.0.1";

  const server = createServer((request, response) => {
    void route(request, response, options.projectDir).catch((error: unknown) => {
      // The scheduler's own faults keep their machine-readable code: a corrupt
      // registry answers `corrupt_registry`, not an empty task list that reads
      // as "nothing scheduled".
      if (error instanceof AppError) {
        respondError(response, 503, error.code, error.message);
        return;
      }
      respondError(response, 500, "internal", error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? DEFAULT_DASHBOARD_PORT, host, () => resolveListen());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    server,
    url: `http://${host}:${port}/`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

/** The store paths of the project owning a task id, if that task exists. */
async function projectPathsFor(taskId: string): Promise<ReturnType<typeof schedulerPaths> | undefined> {
  const task = findTask(await loadRegistry(), taskId);
  return task ? schedulerPaths(task.projectDir) : undefined;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  projectDir: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    respondError(response, 405, "method_not_allowed", "GET only");
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    respond(response, 200, dashboardPage(projectDir), "text/html; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/overview") {
    // Global view: every registry task, latest run read from each task's own
    // project. The aggregates let a caller answer "how is the machine doing"
    // without walking the task array itself.
    const tasks = await listTasks(projectDir);
    const withRuns: TaskOverview[] = await Promise.all(
      tasks.map(async (task) => {
        const runs = await listRuns(schedulerPaths(task.projectDir).runsDir);
        return { ...task, latestRun: runs.find((run) => run.taskId === task.id) };
      }),
    );
    const overview: OverviewResponse = {
      generatedAt: new Date().toISOString(),
      total: withRuns.length,
      enabled: withRuns.filter((task) => task.enabled).length,
      failures: withRuns.filter((task) => (task.latestRun?.status ?? task.lastStatus) === "error").length,
      tasks: withRuns,
    };
    respond(response, 200, overview);
    return;
  }

  if (url.pathname === "/api/runs") {
    const taskId = url.searchParams.get("taskId");
    if (!taskId) {
      respondError(response, 400, "missing_parameter", "taskId query parameter is required");
      return;
    }
    const limit = clampLimit(url.searchParams.get("limit"));
    const runsDir = (await projectPathsFor(taskId))?.runsDir;
    const runs = runsDir ? await listRunsForTask(runsDir, taskId) : [];
    const page = runs.slice(0, limit);
    const body: RunsResponse = {
      taskId,
      total: runs.length,
      returned: page.length,
      has_more: page.length < runs.length,
      ...(page.length < runs.length ? { next_limit: runs.length } : {}),
      runs: page,
    };
    respond(response, 200, body);
    return;
  }

  const sessionMatch = /^\/api\/session\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (sessionMatch) {
    const [, taskId, runId] = sessionMatch;
    if (!isSafeId(taskId) || !isSafeId(runId)) {
      respondError(response, 404, "not_found", "No such session record");
      return;
    }
    const projectPaths = await projectPathsFor(taskId);
    // The run record carries the session's actual location — the layout the
    // adapter wrote it to, which may be the scheduler-private store or an
    // agent's own store (AGENTS_CRON_PI_STORE). It is the source of truth;
    // the fixed private-layout path below only backfills records that predate
    // a sessionFile field.
    const run = projectPaths ? await readRun(projectPaths.runsDir, runId) : undefined;
    if (run?.sessionFile) {
      const text = await readCapped(run.sessionFile);
      if (text !== undefined) {
        respond(
          response,
          200,
          text.content,
          run.sessionFile.endsWith(".json") ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
        );
        return;
      }
    }
    const sessionsDir = projectPaths?.sessionsDir;
    for (const extension of [".json", ".jsonl"]) {
      if (!sessionsDir) break;
      const file = join(sessionsDir, taskId, runId + extension);
      const text = await readCapped(file);
      if (text !== undefined) {
        respond(
          response,
          200,
          text.content,
          extension === ".json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
        );
        return;
      }
    }
    respondError(response, 404, "not_found", "No such session record");
    return;
  }

  respondError(response, 404, "not_found", "Not found");
}

function clampLimit(raw: string | null): number {
  const parsed = Number(raw ?? "20");
  if (!Number.isInteger(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 200);
}

/** Task and run ids are generated tokens; anything else is a probe, not an id. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length <= 128;
}

/**
 * Reads a session record, keeping at most MAX_SESSION_BYTES bytes; a tailed
 * record is prefixed so the dashboard says what happened. Missing files
 * return undefined so the caller can try the next extension.
 */
async function readCapped(file: string): Promise<{ content: string } | undefined> {
  let buffer: Buffer;
  try {
    buffer = await readFile(file);
  } catch {
    return undefined;
  }
  if (buffer.byteLength <= MAX_SESSION_BYTES) return { content: buffer.toString("utf8") };
  const tail = buffer.subarray(Math.max(0, buffer.byteLength - MAX_SESSION_BYTES)).toString("utf8");
  return { content: `… (older bytes omitted; showing the last ${MAX_SESSION_BYTES} of ${buffer.byteLength})\n${tail}` };
}

/** The one error shape: a machine-readable code beside the sentence. */
function respondError(response: ServerResponse, status: number, code: string, message: string): void {
  respond(response, status, { error: { code, message } } satisfies ErrorResponse);
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
  contentType = "application/json; charset=utf-8",
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  response.end(text);
}
