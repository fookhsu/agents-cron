import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test, { before, after } from "node:test";

// The runDue integration below writes registry state; keep it off the real home.
let restoreHome: (() => void) | undefined;
before(async () => {
  const home = await mkdtemp(join(tmpdir(), "agents-cron-home-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  restoreHome = () => {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
  };
});
after(() => restoreHome?.());
import { shouldNotify, notifiersFor, dispatchNotifications } from "../src/notify/dispatch.ts";
import { loadNotifyConfig } from "../src/notify/config.ts";
import { emailNotifier, type MailTransport } from "../src/notify/email.ts";
import { systemNotifier, type CommandRunner } from "../src/notify/system.ts";
import { subjectOf } from "../src/notify/format.ts";
import type { NotificationChannel, NotificationsConfig, RunNotification, SystemChannel, WebhookChannel } from "../src/notify/types.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "../src/agents/types.ts";
import type { AgentRegistry } from "../src/agents/registry.ts";
import { runDue } from "../src/runner.ts";
import { saveTasks } from "../src/storage.ts";
import { schedulerPaths } from "../src/paths.ts";
import type { RunRecord, ScheduleTask } from "../src/types.ts";

test("shouldNotify honors the three levels", () => {
  assert.equal(shouldNotify("never", "error"), false);
  assert.equal(shouldNotify("error", "success"), false);
  assert.equal(shouldNotify("error", "error"), true);
  assert.equal(shouldNotify("error", "missed"), true);
  assert.equal(shouldNotify("always", "success"), true);
  assert.equal(shouldNotify("always", "skipped"), false);
});

test("a missing config file means defaults with no channels", async () => {
  const config = await loadNotifyConfig("/nonexistent-project/.agents/cron");
  assert.deepEqual(config, { on: "error", channels: [] });
});

test("a valid config parses and invalid channels are dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-notify-"));
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      version: 1,
      notifications: {
        on: "always",
        defaultTo: ["hook", "", 3],
        channels: [
          { id: "hook", type: "webhook", url: "https://example.com/hook", headers: { Authorization: "Bearer t" } },
          { id: "bad-url", type: "webhook", url: "not-a-url" },
          { id: "mail", type: "email", host: "smtp.example.com", from: "c@example.com", to: "me@example.com" },
          { id: "mystery", type: "carrier-pigeon" },
        ],
      },
    }),
  );
  const config = await loadNotifyConfig(dir);
  assert.equal(config.on, "always");
  assert.deepEqual(config.defaultTo, ["hook"]);
  assert.deepEqual(
    config.channels.map((c: NotificationChannel) => c.id),
    ["hook", "mail"],
  );
});

test("a malformed config degrades to defaults without throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-notify-"));
  await writeFile(join(dir, "config.json"), "{ not json");
  const config = await loadNotifyConfig(dir);
  assert.deepEqual(config, { on: "error", channels: [] });
});

/** Starts a capturing HTTP server; resolves with its URL, received requests, and a closer. */
async function capturingServer(): Promise<{
  url: string;
  requests: Array<{ headers: Record<string, string>; body: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ headers: Record<string, string>; body: string }> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers as Record<string, string>, body });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test("a webhook notifier posts the run as JSON with the configured headers", async () => {
  const server = await capturingServer();
  const channel: WebhookChannel = {
    id: "hook",
    type: "webhook",
    url: server.url,
    headers: { Authorization: "Bearer token" },
  };
  await notifiersFor({ on: "always", channels: [channel] })[0].send(sampleNotification("error"));

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].headers.authorization, "Bearer token");
  assert.equal(server.requests[0].headers["content-type"], "application/json");
  try {
    const payload = JSON.parse(server.requests[0].body);
    assert.equal(payload.source, "agents-cron");
    assert.equal(payload.status, "error");
    assert.equal(payload.taskId, "task_1");
  } finally {
    await server.close();
  }
});

test("a text webhook posts the human subject and body", async () => {
  const server = await capturingServer();
  const channel: WebhookChannel = { id: "hook", type: "webhook", url: server.url, format: "text" };
  await notifiersFor({ on: "always", channels: [channel] })[0].send(sampleNotification("success"));

  try {
    const [request] = server.requests;
    assert.equal(request.headers["content-type"], "text/plain; charset=utf-8");
    assert.ok(request.body.startsWith("✓ nightly digest success"));
    assert.ok(request.body.includes("All 82 tests passed"));
  } finally {
    await server.close();
  }
});

test("an email notifier sends subject and body through the transport", async () => {
  const sent: Array<{ subject: string; text: string; from: string; to: string }> = [];
  const transport: MailTransport = {
    sendMail: async (options) => {
      sent.push(options);
      return {};
    },
  };
  const notifier = emailNotifier(
    { id: "mail", type: "email", host: "smtp.example.com", from: "cron@example.com", to: "me@example.com, team@example.com", user: "cron@example.com" },
    { AGENTS_CRON_SMTP_PASSWORD: "hunter2" },
    async () => transport,
  );
  await notifier.send(sampleNotification("error"));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "cron@example.com");
  assert.equal(sent[0].to, "me@example.com, team@example.com");
  assert.ok(sent[0].subject.startsWith("[agents-cron] ✗"));
  assert.ok(sent[0].text.includes("error: provider unavailable"));
});

test("an email channel with a user but no password fails with a pointer to the env var", async () => {
  const notifier = emailNotifier(
    { id: "mail", type: "email", host: "smtp.example.com", from: "c@example.com", to: "m@example.com", user: "c@example.com", passwordEnv: "MAIL_KEY" },
    {},
    async () => ({ sendMail: async () => ({}) }),
  );
  await assert.rejects(notifier.send(sampleNotification("success")), /MAIL_KEY is not set/);
});

test("dispatch honors a task-level notify override and never throws", async () => {
  const server = await capturingServer();
  const config = {
    on: "always",
    channels: [{ id: "hook", type: "webhook", url: server.url } as WebhookChannel, { id: "dead", type: "webhook", url: "http://127.0.0.1:1/nope" } as WebhookChannel],
  } satisfies NotificationsConfig;
  const task = minimalTask({ notify: "never" });

  // "never" on the task wins over "always" in the config: nothing is sent.
  await dispatchNotifications(config, task, terminalRun("success"), "/proj/demo");
  assert.equal(server.requests.length, 0);

  try {
    // Without the override, "always" sends — and the dead channel only warns.
    await dispatchNotifications(config, minimalTask({}), terminalRun("success"), "/proj/demo");
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("dispatch routes a task to only its notifyTo channels", async () => {
  const a = await capturingServer();
  const b = await capturingServer();
  const config = {
    on: "always",
    channels: [
      { id: "hook-a", type: "webhook", url: a.url } as WebhookChannel,
      { id: "hook-b", type: "webhook", url: b.url } as WebhookChannel,
    ],
  } satisfies NotificationsConfig;

  try {
    await dispatchNotifications(config, minimalTask({ notifyTo: ["hook-a"] }), terminalRun("success"), "/proj/demo");
    assert.equal(a.requests.length, 1);
    assert.equal(b.requests.length, 0);
  } finally {
    await a.close();
    await b.close();
  }
});

test("an unknown notifyTo id warns; the matched channels still deliver", async () => {
  const server = await capturingServer();
  const config = { on: "always", channels: [{ id: "hook", type: "webhook", url: server.url }] } satisfies NotificationsConfig;

  try {
    // One match plus one typo: the match delivers, the typo is skipped, nothing throws.
    await dispatchNotifications(config, minimalTask({ notifyTo: ["hook", "typo"] }), terminalRun("success"), "/proj/demo");
    assert.equal(server.requests.length, 1);

    // Only unknown ids: nothing delivers, and it still must not throw.
    await dispatchNotifications(config, minimalTask({ notifyTo: ["gone"] }), terminalRun("success"), "/proj/demo");
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("a failing run notifies the configured webhook end to end", async () => {
  const project = await mkdtemp(join(tmpdir(), "agents-cron-proj-"));
  const paths = schedulerPaths(project);
  const server = await capturingServer();
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    join(paths.dir, "config.json"),
    JSON.stringify({ version: 1, notifications: { on: "error", channels: [{ id: "hook", type: "webhook", url: server.url }] } }),
  );

  class ExplodingAgent implements AgentAdapter {
    readonly id = "boom";
    readonly displayName = "Boom";
    async run(_request: AgentRunRequest): Promise<AgentRunResult> {
      throw new Error("provider unavailable");
    }
  }
  const registry: AgentRegistry = {
    resolve: async () => new ExplodingAgent(),
    list: () => [],
  };

  const task = minimalTask({ nextRunAt: "2026-01-01T00:00:00.000Z" });
  await saveTasks(paths.tasksFile, [task]);

  const result = await runDue({ projectDir: project, agents: registry, now: new Date("2026-01-01T00:00:30.000Z") });
  assert.equal(result.failures, 1);
  assert.equal(server.requests.length, 1);

  try {
    const payload = JSON.parse(server.requests[0].body);
    assert.equal(payload.status, "error");
    assert.equal(payload.taskId, task.id);
    assert.ok(payload.error.includes("provider unavailable"));
  } finally {
    await server.close();
  }
});

function sampleNotification(status: RunNotification["status"]): RunNotification {
  return {
    project: "demo",
    taskId: "task_1",
    taskName: "nightly digest",
    runId: "run_1",
    trigger: "scheduled",
    status,
    exitCode: status === "success" ? 0 : 1,
    agent: "pi",
    summary: status === "success" ? "All 82 tests passed." : undefined,
    error: status === "error" ? "provider unavailable" : undefined,
    startedAt: "2026-10-18T09:00:00.000Z",
    finishedAt: "2026-10-18T09:01:00.000Z",
  };
}

function terminalRun(status: RunRecord["status"]): RunRecord {
  return {
    runId: "run_1",
    taskId: "task_1",
    trigger: "scheduled",
    startedAt: "2026-10-18T09:00:00.000Z",
    finishedAt: "2026-10-18T09:01:00.000Z",
    status,
    exitCode: 0,
  };
}

function minimalTask(overrides: Partial<ScheduleTask>): ScheduleTask {
  return {
    id: "task_1",
    projectDir: "/proj",
    name: "nightly digest",
    prompt: "summarize the day",
    schedule: { kind: "interval", everyMs: 3_600_000 },
    enabled: true,
    nextRunAt: "2030-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("a feishu webhook posts the Feishu bot msg_type/content body", async () => {
  const server = await capturingServer();
  const channel: WebhookChannel = { id: "hook", type: "webhook", url: server.url, format: "feishu" };
  await notifiersFor({ on: "always", channels: [channel] })[0].send(sampleNotification("success"));

  try {
    const [request] = server.requests;
    assert.equal(request.headers["content-type"], "application/json");
    const payload = JSON.parse(request.body);
    assert.equal(payload.msg_type, "text");
    assert.ok(payload.content.text.startsWith("✓ nightly digest success"));
    assert.ok(payload.content.text.includes("All 82 tests passed"));
  } finally {
    await server.close();
  }
});

test("a feishu webhook fails loudly when the bot rejects the message", async () => {
  let call = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      call += 1;
      res.writeHead(200, { "content-type": "application/json" });
      // Feishu answers HTTP 200 even for business errors; code carries the truth.
      res.end(call === 1 ? JSON.stringify({ code: 0, msg: "ok" }) : JSON.stringify({ code: 19021, msg: "sign match fail" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const channel: WebhookChannel = {
    id: "hook",
    type: "webhook",
    url: `http://127.0.0.1:${address.port}/hook`,
    format: "feishu",
  };
  const notifier = notifiersFor({ on: "always", channels: [channel] })[0];
  try {
    await notifier.send(sampleNotification("success")); // code 0 — fine
    await assert.rejects(notifier.send(sampleNotification("success")), /19021.*sign match fail/);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a system channel parses with its optional sound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agents-cron-notify-"));
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      version: 1,
      notifications: {
        channels: [
          { id: "mac", type: "system", sound: "Glass" },
          { id: "bare", type: "system" },
          { id: "no-sound-type", type: "system", sound: 42 },
        ],
      },
    }),
  );
  const config = await loadNotifyConfig(dir);
  assert.deepEqual(config.channels, [
    { id: "mac", type: "system", sound: "Glass" },
    { id: "bare", type: "system" },
    { id: "no-sound-type", type: "system" }, // bad sound is tolerated, like email's port
  ]);
});

test("a system notifier drives macOS Notification Center via osascript", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { status: 0, stderr: "" };
  };
  const channel: SystemChannel = { id: "mac", type: "system", sound: "Glass" };

  await systemNotifier(channel, "darwin", run).send(sampleNotification("success"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "osascript");
  const script = calls[0].args[1];
  assert.match(script, /^display notification "/);
  assert.ok(script.includes('with title "agents-cron ✓ nightly digest success"'));
  assert.match(script, /subtitle "demo"/);
  assert.match(script, /sound name "Glass"/);
  assert.ok(script.includes("All 82 tests passed"));
});

test("a system notifier escapes quotes and backslashes in model output", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { status: 0, stderr: "" };
  };
  const notification = sampleNotification("error");
  notification.error = 'say "hi" \\ done';

  await systemNotifier({ id: "mac", type: "system" }, "darwin", run).send(notification);

  // The raw payload must not survive into the AppleScript string unescaped.
  const script = calls[0].args[1];
  assert.ok(!script.includes('say "hi"'));
  assert.ok(script.includes('say \\"hi\\"'));
});

test("a system notifier drives Linux notify-send and caps the summary", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return { status: 0, stderr: "" };
  };
  const notification = sampleNotification("success");
  notification.summary = "x".repeat(1_000);

  await systemNotifier({ id: "linux", type: "system" }, "linux", run).send(notification);

  assert.deepEqual(calls[0].command, "notify-send");
  assert.ok(calls[0].args[0].startsWith("agents-cron"));
  assert.ok(calls[0].args[1].length < 600);
  assert.ok(calls[0].args[1].endsWith("…"));
});

test("a system notifier reports a failing osascript and an unsupported platform", async () => {
  const failed: CommandRunner = async () => ({ status: 1, stderr: "boom" });
  await assert.rejects(
    systemNotifier({ id: "mac", type: "system" }, "darwin", failed).send(sampleNotification("success")),
    /osascript exited 1: boom/,
  );
  await assert.rejects(
    systemNotifier({ id: "win", type: "system" }, "win32", async () => ({ status: 0, stderr: "" })).send(sampleNotification("success")),
    /supports macOS and Linux, not win32/,
  );
});

test("config defaultTo routes tasks that name no channels of their own", async () => {
  const a = await capturingServer();
  const b = await capturingServer();
  const config = {
    on: "always",
    defaultTo: ["hook-b"],
    channels: [
      { id: "hook-a", type: "webhook", url: a.url } as WebhookChannel,
      { id: "hook-b", type: "webhook", url: b.url } as WebhookChannel,
    ],
  } satisfies NotificationsConfig;

  try {
    // No task routing: the config default decides.
    await dispatchNotifications(config, minimalTask({}), terminalRun("success"), "/proj/demo");
    assert.equal(a.requests.length, 0);
    assert.equal(b.requests.length, 1);

    // A task's own notifyTo still wins over the config default.
    await dispatchNotifications(config, minimalTask({ notifyTo: ["hook-a"] }), terminalRun("success"), "/proj/demo");
    assert.equal(a.requests.length, 1);
    assert.equal(b.requests.length, 1);
  } finally {
    await a.close();
    await b.close();
  }
});
