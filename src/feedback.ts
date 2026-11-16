/**
 * Feedback: the report-a-bug / suggest-a-feature path from both surfaces (the
 * CLI and the /schedule command) to the author's inbox. One module owns the
 * whole story so the two surfaces cannot drift:
 *
 *   collect  — safe diagnostics only: versions, environment facts, the
 *              schedule facts of the mentioned task, recent run records, and
 *              the first line of the last error. Never a prompt, transcript,
 *              notification URL, or credential unless the reporter explicitly
 *              passes --include-prompts.
 *   build    — one Markdown report, saved into the project store before
 *              anything leaves the machine, so the reporter can read exactly
 *              what would be sent.
 *   submit   — through the project's own SMTP channel when one is configured,
 *              otherwise by opening a prefilled mailto: — the saved file is
 *              the attachment either way. A failed send degrades to the
 *              mailto path instead of losing the report.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { firstLine, formatSchedule, stamp } from "./format.ts";
import { loadNotifyConfig } from "./notify/config.ts";
import { nodemailerTransport, type MailTransport, type TransportFactory } from "./notify/email.ts";
import type { EmailChannel } from "./notify/types.ts";
import { schedulerPaths } from "./paths.ts";
import { listRunsForTask } from "./runs.ts";
import { listTasks, requireTask } from "./task-service.ts";
import type { RunRecord, ScheduleTask } from "./types.ts";

/** Where every feedback report lands. */
export const FEEDBACK_EMAIL = "fookhsu@foxmail.com";

export const FEEDBACK_KINDS = ["bug", "idea"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export type FeedbackInput = {
  kind: FeedbackKind;
  /** Which surface assembled the report; the author replies better knowing. */
  via: "cli" | "pi";
  message?: string;
  /** Optional reply address the reporter chose to share. */
  contact?: string;
  /** Task the report is about; adds its schedule facts and recent runs. */
  taskId?: string;
  /** Explicit opt-in to include the task's prompt text. Off by default. */
  includePrompts?: boolean;
  /** Assemble and save only; nothing is sent. */
  dryRun?: boolean;
};

/** Machine facts only — nothing here names files outside the store or people. */
export type FeedbackFacts = {
  reportedAt: string;
  via: FeedbackInput["via"];
  cliVersion?: string;
  node: string;
  platform: string;
  osRelease: string;
  timezone: string;
  utcOffset: string;
  tzEnv?: string;
  project: string;
};

/** The mentioned task, schedule facts only; the prompt joins only on opt-in. */
export type FeedbackTaskDigest = {
  id: string;
  name?: string;
  agent?: string;
  model?: string;
  thinking?: string;
  enabled: boolean;
  schedule: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  successCount?: number;
  errorCount?: number;
  missedCount?: number;
  prompt?: string;
};

export type FeedbackRunDigest = {
  runId: string;
  trigger: string;
  status: string;
  exitCode?: number;
  agent?: string;
  startedAt: string;
  durationMs?: number;
};

export type FeedbackDelivery =
  | { how: "smtp"; channel: string; to: string }
  | { how: "mailto"; to: string; opened: boolean }
  | { how: "saved-only"; to: string; reason: string };

export type FeedbackResult = {
  /** The saved Markdown report — the thing to attach when the mail app opens. */
  file: string;
  report: string;
  delivery: FeedbackDelivery;
  /** Set when the SMTP attempt failed and the mailto path took over. */
  deliveryError?: string;
};

/** Injectable seams, so tests never touch SMTP, the mail app, or the clock. */
export type FeedbackDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createTransport?: TransportFactory;
  openMailto?: (url: string) => Promise<boolean>;
  version?: string;
};

const RECENT_RUN_LIMIT = 5;
const LAST_ERROR_WIDTH = 200;
const HEADLINE_WIDTH = 60;

// --- collect -----------------------------------------------------------------

/** The version of the package this module ships in. */
async function readOwnVersion(): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function utcOffsetLabel(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Environment facts: the "where was this happening" half of every bug report. */
export function collectFacts(projectDir: string, input: FeedbackInput, deps: FeedbackDeps = {}): FeedbackFacts {
  const now = (deps.now ?? (() => new Date()))();
  return {
    reportedAt: now.toISOString(),
    via: input.via,
    cliVersion: deps.version ?? "<unread>",
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    osRelease: os.release(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "(unknown)",
    utcOffset: utcOffsetLabel(now),
    ...(process.env.TZ !== undefined ? { tzEnv: process.env.TZ } : {}),
    project: basename(projectDir),
  };
}

function digestTask(task: ScheduleTask, input: FeedbackInput): FeedbackTaskDigest {
  return {
    id: task.id,
    ...(task.name ? { name: task.name } : {}),
    ...(task.agent ? { agent: task.agent } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.thinking ? { thinking: task.thinking } : {}),
    enabled: task.enabled,
    schedule: formatSchedule(task),
    ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}),
    ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}),
    ...(task.lastStatus ? { lastStatus: task.lastStatus } : {}),
    ...(task.successCount !== undefined ? { successCount: task.successCount } : {}),
    ...(task.errorCount !== undefined ? { errorCount: task.errorCount } : {}),
    ...(task.missedCount !== undefined ? { missedCount: task.missedCount } : {}),
    ...(input.includePrompts ? { prompt: task.prompt } : {}),
  };
}

function digestRuns(runs: RunRecord[]): { runs: FeedbackRunDigest[]; lastError?: string } {
  const recent = runs.slice(0, RECENT_RUN_LIMIT).map((run) => ({
    runId: run.runId,
    trigger: run.trigger,
    status: run.status,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.agent ? { agent: run.agent } : {}),
    startedAt: run.startedAt,
    ...(run.finishedAt ? { durationMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt) } : {}),
  }));
  const failed = runs.find((run) => run.status === "error" || run.status === "missed");
  const lastError = failed?.error ? firstLine(failed.error, LAST_ERROR_WIDTH) : undefined;
  return { runs: recent, ...(lastError ? { lastError } : {}) };
}

// --- build -------------------------------------------------------------------

/**
 * The one report format, shared by both surfaces. Everything it contains is
 * spelled out in its own Privacy section — the reporter reads the promise in
 * the same file that keeps it.
 */
export function buildFeedbackReport(parts: {
  input: FeedbackInput;
  facts: FeedbackFacts;
  task?: FeedbackTaskDigest;
  runs?: FeedbackRunDigest[];
  lastError?: string;
}): string {
  const { input, facts } = parts;
  const lines: string[] = [
    `# agents-cron feedback: ${input.kind}`,
    "",
    `Reported: ${facts.reportedAt} (via ${facts.via})`,
    ...(input.contact ? [`Contact: ${input.contact}`] : []),
    "",
    "## Message",
    "",
    input.message?.trim() || "(none — diagnostics only)",
    "",
    "## Environment",
    "",
    `- agents-cron: ${facts.cliVersion ?? "unknown"}`,
    `- node: ${facts.node}`,
    `- platform: ${facts.platform} (${facts.osRelease})`,
    `- timezone: ${facts.timezone} (${facts.utcOffset})${facts.tzEnv ? `, TZ=${facts.tzEnv}` : ""}`,
    `- project: ${facts.project}`,
  ];

  if (parts.task) {
    const task = parts.task;
    lines.push(
      "",
      `## Task ${task.id}`,
      "",
      ...(task.name ? [`- name: ${task.name}`] : []),
      `- schedule: ${task.schedule}`,
      ...(task.agent ? [`- agent: ${task.agent}`] : []),
      ...(task.model ? [`- model: ${task.model}`] : []),
      ...(task.thinking ? [`- thinking: ${task.thinking}`] : []),
      `- enabled: ${task.enabled}`,
      ...(task.nextRunAt ? [`- next run: ${task.nextRunAt}`] : []),
      ...(task.lastRunAt ? [`- last run: ${task.lastStatus ?? "?"} at ${task.lastRunAt}`] : []),
      `- run counters: ${task.successCount ?? 0} success, ${task.errorCount ?? 0} error, ${task.missedCount ?? 0} missed`,
    );
    if (task.prompt !== undefined) {
      lines.push("", "### Prompt (included by explicit request)", "", "```", task.prompt, "```");
    }
  }

  if (parts.runs?.length) {
    lines.push("", "## Recent runs (newest first)", "");
    for (const run of parts.runs) {
      const duration = run.durationMs !== undefined ? `, ${formatDuration(run.durationMs)}` : "";
      const exit = run.exitCode !== undefined ? `, exit ${run.exitCode}` : "";
      const agent = run.agent ? `, ${run.agent}` : "";
      lines.push(`- ${run.runId} [${run.status}] ${run.trigger}${agent}${exit} — ${stamp(run.startedAt)}${duration}`);
    }
  }
  if (parts.lastError) {
    lines.push("", "## Last error", "", "```", parts.lastError, "```");
  }

  lines.push(
    "",
    "## Privacy",
    "",
    "Assembled automatically by agents-cron. This report contains versions and",
    "environment facts, the schedule facts of the mentioned task, recent run",
    "records (ids, statuses, timings), and the first line of the last error.",
    "It does not contain task prompts, session transcripts, notification channel",
    "configuration, credentials, or file contents.",
    ...(input.includePrompts
      ? ["The task prompt is included because the reporter explicitly asked", "for it with --include-prompts."]
      : []),
    "",
  );
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

// --- submit ------------------------------------------------------------------

function feedbackFilename(kind: FeedbackKind, now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${kind}.md`;
}

function feedbackSubject(input: FeedbackInput): string {
  const headline = firstLine(input.message ?? input.taskId ?? "", HEADLINE_WIDTH) || "no description";
  return `[agents-cron feedback] ${input.kind}: ${headline}`;
}

function mailtoUrl(input: FeedbackInput, file: string): string {
  const body = [
    "(sent from agents-cron feedback — please attach the report file)",
    "",
    `Kind: ${input.kind}`,
    `Report file: ${file}`,
    ...(input.contact ? [`Contact: ${input.contact}`] : []),
    "",
    input.message?.trim() ?? "",
  ].join("\n");
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(feedbackSubject(input))}&body=${encodeURIComponent(body)}`;
}

const MAIL_OPENERS: Record<string, string[]> = {
  darwin: ["open"],
  win32: ["cmd", "/c", "start", ""],
  linux: ["xdg-open"],
};

/** Best effort: true when a mail application actually took the URL. */
async function defaultOpenMailto(url: string): Promise<boolean> {
  const argv = MAIL_OPENERS[process.platform];
  if (!argv) return false;
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise<boolean>((resolvePromise) => {
      const child = spawn(argv[0], [...argv.slice(1), url], { stdio: "ignore" });
      child.on("error", () => resolvePromise(false));
      child.on("close", (code) => resolvePromise(code === 0));
    });
  } catch {
    return false;
  }
}

async function sendViaChannel(
  channel: EmailChannel,
  input: FeedbackInput,
  report: string,
  file: string,
  deps: FeedbackDeps,
): Promise<{ ok: true; channel: string } | { ok: false; reason: string }> {
  const env = deps.env ?? process.env;
  const passwordEnv = channel.passwordEnv ?? "AGENTS_CRON_SMTP_PASSWORD";
  const password = env[passwordEnv];
  if (channel.user && !password) {
    return { ok: false, reason: `SMTP password not set (${passwordEnv})` };
  }
  const createTransport = deps.createTransport ?? nodemailerTransport;
  let transport: MailTransport;
  try {
    transport = await createTransport(channel, password);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    await transport.sendMail({
      from: channel.from,
      to: FEEDBACK_EMAIL,
      subject: feedbackSubject(input),
      text: report,
      // The saved report rides along as a real attachment, so the author
      // gets the file without the reporter touching a mail client.
      attachments: [{ filename: basename(file), path: file, contentType: "text/markdown" }],
    });
    return { ok: true, channel: channel.id };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The one path behind `agents-cron feedback` and `/schedule feedback`:
 * collect, save locally first, then hand the report to the author's inbox —
 * SMTP when this project configured an email channel, a prefilled mailto:
 * otherwise, and the mailto again when SMTP fails. The saved file is always
 * the attachment, so nothing is sent that the reporter could not read first.
 */
export async function submitFeedback(projectDir: string, input: FeedbackInput, deps: FeedbackDeps = {}): Promise<FeedbackResult> {
  const facts = collectFacts(projectDir, input, deps);
  if (facts.cliVersion === "<unread>") facts.cliVersion = await readOwnVersion();

  let task: FeedbackTaskDigest | undefined;
  let runs: FeedbackRunDigest[] | undefined;
  let lastError: string | undefined;
  if (input.taskId) {
    const found = requireTask(await listTasks(projectDir), input.taskId);
    task = digestTask(found, input);
    const projectRuns = await listRunsForTask(schedulerPaths(found.projectDir).runsDir, found.id);
    ({ runs, lastError } = digestRuns(projectRuns));
  }

  const report = buildFeedbackReport({ input, facts, ...(task ? { task } : {}), ...(runs ? { runs } : {}), ...(lastError ? { lastError } : {}) });

  const now = (deps.now ?? (() => new Date()))();
  const file = join(schedulerPaths(projectDir).dir, "feedback", feedbackFilename(input.kind, now));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, report, "utf8");

  if (input.dryRun) {
    return { file, report, delivery: { how: "saved-only", to: FEEDBACK_EMAIL, reason: "dry run" } };
  }

  const config = await loadNotifyConfig(schedulerPaths(projectDir).dir);
  const channel = config.channels.find((entry): entry is EmailChannel => entry.type === "email");
  if (channel) {
    const sent = await sendViaChannel(channel, input, report, file, deps);
    if (sent.ok) {
      return { file, report, delivery: { how: "smtp", channel: sent.channel, to: FEEDBACK_EMAIL } };
    }
    // SMTP failed: the report is already saved — degrade to the mailto path.
    const opened = await (deps.openMailto ?? defaultOpenMailto)(mailtoUrl(input, file));
    return {
      file,
      report,
      delivery: { how: "mailto", to: FEEDBACK_EMAIL, opened },
      deliveryError: sent.reason,
    };
  }

  const opened = await (deps.openMailto ?? defaultOpenMailto)(mailtoUrl(input, file));
  return { file, report, delivery: { how: "mailto", to: FEEDBACK_EMAIL, opened } };
}

// --- render ------------------------------------------------------------------

/**
 * The lines both surfaces show, in order: where the report is, what happened
 * to it, and the privacy promise the collection rules keep.
 */
export function feedbackResultLines(result: FeedbackResult, input: FeedbackInput): string[] {
  const lines = [`Report saved: ${result.file}`];
  if (result.delivery.how === "smtp") {
    lines.push(`Sent via SMTP channel "${result.delivery.channel}" to ${result.delivery.to} — report attached.`);
  } else if (result.delivery.how === "mailto") {
    if (result.deliveryError) lines.push(`SMTP send failed (${result.deliveryError}); falling back to your mail app.`);
    lines.push(
      result.delivery.opened
        ? `Opened your mail app to ${result.delivery.to} — attach the report file before sending.`
        : `Could not open a mail app — write to ${result.delivery.to} and attach the report file.`,
    );
  } else {
    lines.push(`${result.delivery.reason}: nothing was sent; the report shows exactly what would be.`);
  }
  // A bug the reporter cannot reproduce is the author's problem to guess;
  // the opt-in is named where it can be acted on, once, without nagging.
  if (input.kind === "bug" && !input.includePrompts) {
    lines.push("If the problem involves what the task was doing, resend with --include-prompts to attach the prompt.");
  }
  lines.push(
    input.includePrompts
      ? "Privacy: the task prompt is included because you asked for it (--include-prompts)."
      : "Privacy: nothing private is uploaded — no prompts, transcripts, or credentials are collected; the saved report shows exactly what was sent.",
  );
  return lines;
}
