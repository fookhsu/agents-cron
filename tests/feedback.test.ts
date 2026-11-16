import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { main, type CliDeps } from "../src/cli.ts";
import { FEEDBACK_EMAIL, buildFeedbackReport, collectFacts, feedbackResultLines, submitFeedback } from "../src/feedback.ts";
import { parseFeedbackArgs } from "../src/agents/pi/commands.ts";
import { completeScheduleArguments, scheduleCompletionNeeds } from "../src/agents/pi/completions.ts";
import { addTask } from "../src/task-service.ts";
import { writeRun } from "../src/runs.ts";
import { schedulerPaths } from "../src/paths.ts";
import type { RunRecord, ScheduleTask } from "../src/types.ts";
import type { MailTransport } from "../src/notify/email.ts";

// Every test runs against a throwaway Task Registry.
let restoreHome: (() => void) | undefined;
before(async () => {
  const home = await mkdtemp(join(tmpdir(), "agents-cron-feedback-home-"));
  const previous = process.env.AGENTS_CRON_HOME;
  process.env.AGENTS_CRON_HOME = home;
  restoreHome = () => {
    if (previous !== undefined) process.env.AGENTS_CRON_HOME = previous;
    else delete process.env.AGENTS_CRON_HOME;
  };
});
after(() => restoreHome?.());

beforeEach(async () => {
  const { saveRegistry } = await import("../src/registry.ts");
  await saveRegistry([]);
});

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agents-cron-feedback-"));
}

function capture(projectDir: string): { deps: CliDeps; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    deps: {
      cwd: projectDir,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

const SECRET_PROMPT = "audit the repo and mail SECRET-TOKEN-123 to the boss";

async function seedTask(projectDir: string): Promise<ScheduleTask> {
  const task = await addTask(projectDir, {
    prompt: SECRET_PROMPT,
    schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
    name: "nightly audit",
  });
  const record: RunRecord = {
    runId: "run_20260214_test",
    taskId: task.id,
    trigger: "scheduled",
    startedAt: "2026-02-14T01:00:05.000Z",
    finishedAt: "2026-02-14T01:00:10.000Z",
    status: "error",
    exitCode: 1,
    error: "provider unavailable: quota exceeded\nand more lines that must be dropped",
  };
  await writeRun(schedulerPaths(projectDir).runsDir, record);
  return task;
}

test("collectFacts gathers machine facts only, with no paths or people", () => {
  const facts = collectFacts("/Users/someone/secret-project", { kind: "bug", via: "cli" }, { version: "9.9.9" });
  assert.equal(facts.project, "secret-project"); // basename only, no home directory
  assert.equal(facts.cliVersion, "9.9.9");
  assert.match(facts.timezone, /UTC|Etc|Asia|Europe|America|Africa|Australia|Pacific/);
  assert.match(facts.utcOffset, /^UTC[+-]\d{2}:\d{2}$/);
});

test("the report carries schedule facts and run digests, and keeps prompts out by default", async () => {
  const projectDir = await project();
  const task = await seedTask(projectDir);
  const result = await submitFeedback(projectDir, {
    kind: "bug",
    via: "cli",
    message: "cron runs missed at 09:00",
    taskId: task.id,
    dryRun: true,
  });

  assert.equal(result.delivery.how, "saved-only");
  const report = result.report;
  assert.match(report, /# agents-cron feedback: bug/);
  assert.match(report, /cron runs missed at 09:00/);
  assert.match(report, /## Task /);
  assert.match(report, /Asia\/Shanghai/);
  assert.match(report, /provider unavailable: quota exceeded/); // first line only
  assert.ok(!report.includes("and more lines"), "error text is truncated to the first line");
  assert.ok(!report.includes("SECRET-TOKEN-123"), "prompt content must stay out unless asked for");
  assert.match(report, /## Privacy/);
  assert.ok(!report.includes("me@"), "no addresses beyond the author's own");
  assert.ok(existsSync(result.file), "the report is saved before anything is sent");
});

test("--include-prompts is the explicit opt-in that adds the prompt", async () => {
  const projectDir = await project();
  const task = await seedTask(projectDir);
  const result = await submitFeedback(projectDir, {
    kind: "bug",
    via: "cli",
    taskId: task.id,
    includePrompts: true,
    dryRun: true,
  });
  assert.ok(result.report.includes("SECRET-TOKEN-123"));
  assert.match(result.report, /included because the reporter explicitly asked/);
});

test("a configured email channel sends the report to the author, not to the channel's own recipient", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    join(paths.dir, "config.json"),
    JSON.stringify({
      notifications: {
        on: "error",
        channels: [{ id: "self", type: "email", host: "smtp.example.com", user: "me@example.com", from: "me@example.com", to: "me@example.com", passwordEnv: "FEEDBACK_TEST_PW" }],
      },
    }),
    "utf8",
  );

  const sent: Array<{ to: string; subject: string; text: string; attachments?: Array<{ filename?: string; path?: string }> }> = [];
  const transport: MailTransport = { sendMail: async (options) => void sent.push(options as { to: string; subject: string; text: string }) };
  const result = await submitFeedback(
    projectDir,
    { kind: "idea", via: "cli", message: "please add a weekly digest" },
    {
      env: { FEEDBACK_TEST_PW: "secret" },
      createTransport: async () => transport,
    },
  );

  assert.deepEqual(result.delivery, { how: "smtp", channel: "self", to: FEEDBACK_EMAIL });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, FEEDBACK_EMAIL);
  assert.notEqual(sent[0].to, "me@example.com");
  assert.match(sent[0].subject, /^\[agents-cron feedback\] idea: /);
  assert.match(sent[0].text, /weekly digest/);
  // SMTP carries the report as a real attachment — no mail client required.
  assert.equal(sent[0].attachments?.length, 1);
  assert.equal(sent[0].attachments?.[0].path, result.file);
  assert.equal(sent[0].attachments?.[0].filename, basename(result.file));
});

test("a channel without its SMTP password degrades to the mailto path, not an error", async () => {
  const projectDir = await project();
  const paths = schedulerPaths(projectDir);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    join(paths.dir, "config.json"),
    JSON.stringify({
      notifications: {
        on: "error",
        channels: [{ id: "self", type: "email", host: "smtp.example.com", user: "me@example.com", from: "me@example.com", to: "me@example.com" }],
      },
    }),
    "utf8",
  );

  const opened: string[] = [];
  const result = await submitFeedback(projectDir, { kind: "bug", via: "cli", message: "boom" }, { openMailto: async (url) => (opened.push(url), true) });

  assert.equal(result.delivery.how, "mailto");
  assert.match(result.deliveryError ?? "", /SMTP password not set/);
  assert.match(opened[0], /^mailto:fookhsu@foxmail\.com\?subject=/);
});

test("no channels at all still gets the report out through mailto", async () => {
  const projectDir = await project();
  const opened: string[] = [];
  const result = await submitFeedback(projectDir, { kind: "bug", via: "cli", message: "boom" }, { openMailto: async (url) => (opened.push(url), true) });

  assert.deepEqual(result.delivery, { how: "mailto", to: FEEDBACK_EMAIL, opened: true });
  assert.match(opened[0], /Kind%3A%20bug/);
  assert.ok(existsSync(result.file));
  const saved = await readFile(result.file, "utf8");
  assert.match(saved, /# agents-cron feedback: bug/);
});

test("feedbackResultLines states the file, the privacy promise, and the include-prompts hint once", () => {
  const input = { kind: "bug" as const, via: "cli" as const };
  const lines = feedbackResultLines(
    { file: "/tmp/report.md", report: "", delivery: { how: "mailto", to: FEEDBACK_EMAIL, opened: false } },
    input,
  );
  assert.match(lines[0], /^Report saved: \/tmp\/report\.md$/);
  assert.ok(lines.some((line) => line.includes("--include-prompts")), "a plain bug report names the opt-in");
  assert.match(lines.at(-1)!, /nothing private is uploaded/);
  assert.ok(!lines.at(-1)!.includes("prompts are included"), "the opt-in changes the privacy line");

  const optedIn = feedbackResultLines(
    { file: "/tmp/report.md", report: "", delivery: { how: "saved-only", to: FEEDBACK_EMAIL, reason: "dry run" } },
    { ...input, includePrompts: true },
  );
  assert.match(optedIn.at(-1)!, /--include-prompts/);
  assert.equal(optedIn.filter((line) => line.includes("resend with")).length, 0, "no hint when the prompt is already attached");

  const idea = feedbackResultLines(
    { file: "/tmp/report.md", report: "", delivery: { how: "saved-only", to: FEEDBACK_EMAIL, reason: "dry run" } },
    { kind: "idea", via: "cli" },
  );
  assert.equal(idea.filter((line) => line.includes("--include-prompts to attach")).length, 0, "ideas need no prompt hint");

  const smtp = feedbackResultLines(
    { file: "/tmp/report.md", report: "", delivery: { how: "smtp", channel: "self", to: FEEDBACK_EMAIL } },
    input,
  );
  assert.match(smtp[1], /report attached/);
});

// --- the CLI surface ---------------------------------------------------------

test("agents-cron feedback bug --dry-run saves the report and exits 0", async () => {
  const projectDir = await project();
  const { deps, stdout, stderr } = capture(projectDir);
  const exit = await main(["feedback", "bug", "--message", "runs stop after midnight", "--dry-run"], deps);

  assert.equal(exit, 0);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join("\n"), /Report saved: /);
  assert.match(stdout.join("\n"), /nothing was sent/);
  assert.match(stdout.join("\n"), /nothing private is uploaded/);
});

test("agents-cron feedback digests the named task", async () => {
  const projectDir = await project();
  const task = await seedTask(projectDir);
  const { deps, stdout } = capture(projectDir);
  const exit = await main(["feedback", "bug", task.id, "--dry-run"], deps);

  assert.equal(exit, 0);
  const saved = stdout.join("\n").match(/Report saved: (\S+)/)?.[1];
  assert.ok(saved);
  const report = await readFile(saved, "utf8");
  assert.match(report, new RegExp(task.id));
  assert.ok(!report.includes("SECRET-TOKEN-123"));
});

test("a wrong kind is bad input, exit 2", async () => {
  const projectDir = await project();
  const { deps, stderr } = capture(projectDir);
  const exit = await main(["feedback", "shout", "--message", "hi"], deps);

  assert.equal(exit, 2);
  assert.match(stderr.join("\n"), /kind must be bug or idea/);
});

test("an unknown task id is bad input, exit 2", async () => {
  const projectDir = await project();
  const { deps, stderr } = capture(projectDir);
  const exit = await main(["feedback", "bug", "task_nope1234", "--dry-run"], deps);

  assert.equal(exit, 2);
  assert.match(stderr.join("\n"), /Task not found/);
});

test("agents-cron help mentions feedback", async () => {
  const projectDir = await project();
  const { deps, stdout } = capture(projectDir);
  const exit = await main(["help"], deps);

  assert.equal(exit, 0);
  assert.match(stdout.join("\n"), /feedback bug\|idea/);
});

// --- the /schedule surface ---------------------------------------------------

test("/schedule feedback parsing: kind, optional task id, message, flags", () => {
  assert.deepEqual(parseFeedbackArgs(["bug"]), { kind: "bug" });
  const withTask = parseFeedbackArgs(["bug", "task_ab12cd34", "runs", "missed", "at", "9am", "--contact", "me@example.com"]);
  assert.deepEqual(withTask, { kind: "bug", taskId: "task_ab12cd34", contact: "me@example.com", message: "runs missed at 9am" });
  const withPrompt = parseFeedbackArgs(["idea", "add", "a", "digest", "--include-prompts"]);
  assert.deepEqual(withPrompt, { kind: "idea", includePrompts: true, message: "add a digest" });
  assert.throws(() => parseFeedbackArgs([]), /Usage: \/schedule feedback/);
  assert.throws(() => parseFeedbackArgs(["shout", "hi"]), /Usage: \/schedule feedback/);
  assert.throws(() => parseFeedbackArgs(["bug", "not-a-task-id", "--contact"]), /--contact needs an email/);
  assert.throws(() => parseFeedbackArgs(["bug", "--wat"]), /Unexpected "--wat"/);
});

test("a task-shaped word is treated as an id only when it really is one", () => {
  assert.deepEqual(parseFeedbackArgs(["bug", "task_XY"]).message, "task_XY"); // ids are lowercase hex
  assert.equal(parseFeedbackArgs(["bug", "task_ab12cd34", "msg"]).taskId, "task_ab12cd34");
});

test("feedback kinds are suggested as /schedule arguments without reading the store", () => {
  assert.deepEqual(scheduleCompletionNeeds("feedback "), { tasks: false, runs: false });
  const items = completeScheduleArguments("feedback ", [], []);
  assert.deepEqual(items?.map((item) => item.value), ["feedback bug", "feedback idea"]);
  assert.equal(completeScheduleArguments("feedback x", [], []), null);
  assert.equal(completeScheduleArguments("feedback bug ", [], []), null);
});

// --- report rendering --------------------------------------------------------

test("the report is self-describing about privacy in both directions", () => {
  const facts = collectFacts("/tmp/p", { kind: "bug", via: "pi" }, { version: "0.18.1", now: () => new Date("2026-02-14T09:30:00Z") });
  const plain = buildFeedbackReport({
    input: { kind: "bug", via: "pi", message: "m" },
    facts,
    task: { id: "task_x", enabled: true, schedule: "every 1h", prompt: undefined },
    runs: [{ runId: "r1", trigger: "manual", status: "success", startedAt: "2026-02-14T09:00:00Z", durationMs: 4200 }],
  });
  assert.match(plain, /It does not contain task prompts/);
  assert.ok(!plain.includes("--include-prompts"));

  const opted = buildFeedbackReport({
    input: { kind: "bug", via: "pi", includePrompts: true },
    facts,
    task: { id: "task_x", enabled: true, schedule: "every 1h", prompt: "p" },
  });
  assert.match(opted, /### Prompt \(included by explicit request\)/);
});

test("run digests show timing, not summaries", async () => {
  const projectDir = await project();
  const task = await seedTask(projectDir);
  await writeRun(schedulerPaths(projectDir).runsDir, {
    runId: "run_summary_test",
    taskId: task.id,
    trigger: "manual",
    startedAt: "2026-02-14T02:00:00.000Z",
    finishedAt: "2026-02-14T02:00:30.000Z",
    status: "success",
    summary: "the session said something about SECRET-TOKEN-123",
  });
  const result = await submitFeedback(projectDir, { kind: "bug", via: "cli", taskId: task.id, dryRun: true });
  assert.match(result.report, /run_summary_test \[success\] manual.*30\.0s/);
  assert.ok(!result.report.includes("the session said"), "run summaries are content; they stay out");
});

test("cleanup", async () => {
  // registry home tmpdir is removed with the process tmp; nothing to do.
  await rm(join(tmpdir(), "agents-cron-feedback-"), { recursive: true, force: true }).catch(() => undefined);
});
