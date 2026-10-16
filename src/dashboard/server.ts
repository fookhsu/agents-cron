import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { schedulerPaths } from "../paths.ts";
import { listRuns, listRunsForTask } from "../runs.ts";
import { listTasks } from "../task-service.ts";
import type { RunRecord, ScheduleTask } from "../types.ts";
import { dashboardPage } from "./page.ts";

/** The default port for `pi-scheduler dashboard`. 7383 = "sdh" on a keypad. */
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
 * A read-only, localhost-only dashboard over the project's scheduler store.
 * It starts on demand (`pi-scheduler dashboard`), serves JSON from the same
 * files the CLI reads, and never mutates anything — so it needs no run lock
 * and coexists with cron's `run-due`.
 */
export async function startDashboard(options: {
  projectDir: string;
  port?: number;
  host?: string;
}): Promise<DashboardHandle> {
  const host = options.host ?? "127.0.0.1";
  const paths = schedulerPaths(options.projectDir);

  const server = createServer((request, response) => {
    void route(request, response, options.projectDir, paths).catch((error: unknown) => {
      respond(response, 500, { error: error instanceof Error ? error.message : String(error) });
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

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  projectDir: string,
  paths: ReturnType<typeof schedulerPaths>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    respond(response, 405, { error: "GET only" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    respond(response, 200, dashboardPage(projectDir), "text/html; charset=utf-8");
    return;
  }

  if (url.pathname === "/api/overview") {
    const tasks = await listTasks(projectDir);
    const runs = await listRuns(paths.runsDir);
    const latest = new Map<string, RunRecord>();
    for (const run of runs) {
      if (latest.has(run.taskId)) continue;
      latest.set(run.taskId, run);
    }
    const overview: { generatedAt: string; tasks: TaskOverview[] } = {
      generatedAt: new Date().toISOString(),
      tasks: tasks.map((task) => ({ ...task, latestRun: latest.get(task.id) })),
    };
    respond(response, 200, overview);
    return;
  }

  if (url.pathname === "/api/runs") {
    const taskId = url.searchParams.get("taskId");
    if (!taskId) {
      respond(response, 400, { error: "taskId query parameter is required" });
      return;
    }
    const limit = clampLimit(url.searchParams.get("limit"));
    const runs = await listRunsForTask(paths.runsDir, taskId);
    respond(response, 200, { taskId, runs: runs.slice(0, limit) });
    return;
  }

  const sessionMatch = /^\/api\/session\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (sessionMatch) {
    const [, taskId, runId] = sessionMatch;
    if (!isSafeId(taskId) || !isSafeId(runId)) {
      respond(response, 404, { error: "No such session record" });
      return;
    }
    for (const extension of [".json", ".jsonl"]) {
      const file = join(paths.sessionsDir, taskId, runId + extension);
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
    respond(response, 404, { error: "No such session record" });
    return;
  }

  respond(response, 404, { error: "Not found" });
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
