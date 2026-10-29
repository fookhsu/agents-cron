import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunRecord, ScheduleTask } from "../src/types.ts";
import {
  completeCronNickname,
  completeReminderShape,
  completeScheduleActions,
  completeScheduleArguments,
  completeTrailingFlags,
  endsInRoutingFlag,
  scheduleCompletionNeeds,
  scheduleArgumentCompletions,
  splitCompleting,
  SCHEDULE_ACTIONS,
  taskSpecArgumentCompletions,
  rememberProjectCwd,
  type ChannelOption,
} from "../src/agents/pi/completions.ts";
import { registerCommands } from "../src/agents/pi/commands.ts";

// --- splitCompleting: where the cursor's word stands ---

test("splitCompleting separates typed words from the word being completed", () => {
  assert.deepEqual(splitCompleting(""), { tokens: [], partial: "" });
  assert.deepEqual(splitCompleting("re"), { tokens: [], partial: "re" });
  assert.deepEqual(splitCompleting("remove "), { tokens: ["remove"], partial: "" });
  assert.deepEqual(splitCompleting("remove task_a"), { tokens: ["remove"], partial: "task_a" });
  assert.deepEqual(splitCompleting("remove  "), { tokens: ["remove"], partial: "" });
});

// --- /schedule: actions, task ids, run ids, export flag ---

test("an empty or partial first word suggests every matching action", () => {
  const all = completeScheduleArguments("", [], []);
  assert.equal(all?.length, SCHEDULE_ACTIONS.length);
  assert.deepEqual(
    completeScheduleActions("re")?.map((item) => item.value),
    ["remove"],
  );
  assert.deepEqual(
    completeScheduleActions("run")?.map((item) => item.value),
    ["run", "runs"],
  );
  assert.equal(completeScheduleActions("zzz"), null);
});

test("id-taking actions suggest real task ids as full replacement values", () => {
  const tasks = [
    task("task_alpha", { enabled: true }),
    task("task_beta", { enabled: false, projectDir: "/elsewhere" }),
  ];

  const all = completeScheduleArguments("enable ", tasks, [], "/project");
  assert.deepEqual(all?.map((item) => item.value), ["enable task_alpha", "enable task_beta"]);
  assert.match(all?.[0].description ?? "", /^enabled — /);
  assert.doesNotMatch(all?.[0].description ?? "", /in \/elsewhere/);
  assert.match(all?.[1].description ?? "", /in \/elsewhere/);

  const filtered = completeScheduleArguments("remove task_al", tasks, []);
  assert.deepEqual(filtered?.map((item) => item.value), ["remove task_alpha"]);

  assert.equal(completeScheduleArguments("disable task_zzz", tasks, []), null);
  // Two words after the action: nothing left to suggest.
  assert.equal(completeScheduleArguments("enable task_alpha oops", tasks, []), null);
});

test("open suggests run ids, filtered by prefix and capped at fifteen", () => {
  const runs = Array.from({ length: 20 }, (_, i) => run(`run_${String(i).padStart(2, "0")}`));

  assert.equal(completeScheduleArguments("open ", [], runs)?.length, 15);

  const prefixed = completeScheduleArguments("open run_0", [], runs);
  assert.equal(prefixed?.length, 10);
  assert.deepEqual(
    prefixed?.slice(0, 2).map((item) => item.value),
    ["open run_00", "open run_01"],
  );
  assert.equal(completeScheduleArguments("open run_99", [], runs), null);
});

test("export completes only its flag, and only when a flag is being typed", () => {
  const items = completeScheduleArguments("export --", [], []);
  assert.equal(items?.length, 1);
  assert.equal(items?.[0].value, "export --all");
  assert.equal(completeScheduleArguments("export agents-cron", [], []), null);
});

test("scheduleCompletionNeeds reads the store only for the branches that need it", () => {
  assert.deepEqual(scheduleCompletionNeeds(""), { tasks: false, runs: false });
  // Still typing the first word: action suggestions, no store read.
  assert.deepEqual(scheduleCompletionNeeds("enab"), { tasks: false, runs: false });
  assert.deepEqual(scheduleCompletionNeeds("show "), { tasks: true, runs: false });
  assert.deepEqual(scheduleCompletionNeeds("open run_"), { tasks: false, runs: true });
  assert.deepEqual(scheduleCompletionNeeds("export --a"), { tasks: false, runs: false });
  assert.equal(scheduleCompletionNeeds("list "), null);
  assert.equal(scheduleCompletionNeeds("enable a b"), null);
});

// --- trailing --to / --notify flags ---

const channels: ChannelOption[] = [
  { id: "feishu", type: "email" },
  { id: "mail", type: "email" },
];

test("--notify completes its three levels", () => {
  assert.deepEqual(
    completeTrailingFlags("--notify al", [])?.map((item) => item.value),
    ["--notify always"],
  );
  assert.deepEqual(
    completeTrailingFlags("check CI --notify ", [])?.map((item) => item.value),
    ["check CI --notify always", "check CI --notify error", "check CI --notify never"],
  );
  assert.equal(completeTrailingFlags("--notify x", []), null);
});

test("--to completes configured channel ids, keeps the typed spelling, and dedupes", () => {
  assert.deepEqual(
    completeTrailingFlags("--to f", channels),
    [{ value: "--to feishu", label: "feishu", description: "email" }],
  );
  assert.deepEqual(
    completeTrailingFlags("--notify-to feishu,m", channels)?.map((item) => item.value),
    ["--notify-to feishu,mail"],
  );
  assert.equal(completeTrailingFlags("--to feishu,f", channels), null);
  assert.equal(completeTrailingFlags("--to f", []), null);
});

test("endsInRoutingFlag is the cheap probe for reading channel config", () => {
  assert.equal(endsInRoutingFlag("--to"), true);
  assert.equal(endsInRoutingFlag("check --notify al"), true);
  assert.equal(endsInRoutingFlag("--notify-to feishu,"), true);
  assert.equal(endsInRoutingFlag("30m check CI"), false);
  assert.equal(endsInRoutingFlag("--to feishu extra words"), false);
});

// --- /loop specs and /remind shapes ---

test("cron nicknames complete only while the spec word starts with @", () => {
  assert.deepEqual(
    completeCronNickname("@da")?.map((item) => item.value),
    ["@daily"],
  );
  assert.equal(completeCronNickname("@da")?.[0].description, "0 0 * * *");
  assert.ok((completeCronNickname("@")?.length ?? 0) >= 6, "a bare @ lists every nickname");
  assert.equal(completeCronNickname("@x"), null);
  assert.equal(completeCronNickname("30m"), null);
  assert.equal(completeCronNickname("@daily check CI"), null);
});

test("/remind suggests its two keyword shapes until the first word ends", () => {
  assert.deepEqual(
    completeReminderShape("")?.map((item) => item.value),
    ["in", "at"],
  );
  assert.deepEqual(completeReminderShape("i")?.map((item) => item.value), ["in"]);
  assert.equal(completeReminderShape("at 09:30"), null);
});

// --- wiring: registered commands reading a real, isolated store ---

type Registered = {
  description: string;
  getArgumentCompletions?: (args: string) => Promise<{ value: string; label: string; description?: string }[] | null>;
  handler: (args: string, ctx: unknown) => Promise<void>;
};

function stubPi() {
  const commands = new Map<string, Registered>();
  const events = new Map<string, ((event: unknown, ctx: unknown) => void)[]>();
  const api = {
    registerCommand: (name: string, definition: Registered) => commands.set(name, definition),
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      events.set(event, [...(events.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  registerCommands(api);
  return { commands, events };
}

test("registered completions read tasks, runs, and channels from the session's project", async (t) => {
  // The registry is machine-global; point it at a throwaway home.
  const home = mkdtempSync(join(tmpdir(), "agents-cron-completions-home-"));
  const project = mkdtempSync(join(tmpdir(), "agents-cron-completions-project-"));
  t.after(() => {
    delete process.env.AGENTS_CRON_HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  process.env.AGENTS_CRON_HOME = home;

  const { commands, events } = stubPi();
  const completions = commands.get("schedule")!.getArgumentCompletions!;
  const loop = commands.get("loop")!.getArgumentCompletions!;

  // session_start is what teaches the completions the project dir.
  await (events.get("session_start") ?? [])[0]({ type: "session_start" }, { cwd: project });

  const { addTask } = await import("../src/task-service.ts");
  const first = await addTask(project, { prompt: "Check the CI", schedule: { kind: "interval", every: "30m" } });
  const second = await addTask(project, { prompt: "Second task", schedule: { kind: "once", runAt: "2026-01-01T00:00:00.000Z" } });

  const enabled = await completions("enable ");
  assert.deepEqual(
    new Set(enabled?.map((item) => item.label)),
    new Set([first.id, second.id]),
  );

  // Run ids come from the project's runs dir.
  const runsDir = join(project, ".agents", "cron", "runs");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, "run_abc.json"), JSON.stringify(runRecord("run_abc", first.id)), "utf8");
  assert.deepEqual((await completions("open "))?.map((item) => item.value), ["open run_abc"]);

  // add behaves like /loop: nickname values carry the typed action along.
  assert.deepEqual((await completions("add @ho"))?.map((item) => item.value), ["add @hourly"]);

  // --to reads the project's notify config.
  writeFileSync(
    join(project, ".agents", "cron", "config.json"),
    JSON.stringify({ notifications: { channels: [{ id: "feishu", type: "webhook", url: "https://example.com" }] } }),
    "utf8",
  );
  assert.deepEqual((await loop("check CI --to fe"))?.map((item) => item.value), ["check CI --to feishu"]);
});

test("completions stay silent when no project dir is known yet", async (t) => {
  // The registry is machine-global; isolate it so the assertion never reads real tasks.
  const home = mkdtempSync(join(tmpdir(), "agents-cron-completions-silent-"));
  t.after(() => {
    delete process.env.AGENTS_CRON_HOME;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.AGENTS_CRON_HOME = home;

  rememberProjectCwd("/definitely/not/a/real/project");
  assert.equal(await scheduleArgumentCompletions("enable "), null);
  // Nickname suggestions read no store, so they work without a known project.
  assert.deepEqual((await taskSpecArgumentCompletions("@daily"))?.map((item) => item.value), ["@daily"]);
});

// --- fixtures ---

function task(id: string, overrides: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id,
    projectDir: "/project",
    prompt: "Check the CI",
    schedule: { kind: "interval", everyMs: 1_800_000 },
    enabled: true,
    ...overrides,
  } as ScheduleTask;
}

function run(runId: string): RunRecord {
  return runRecord(runId, "task_alpha");
}

function runRecord(runId: string, taskId: string): RunRecord {
  return {
    runId,
    taskId,
    trigger: "scheduled",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    status: "success",
  };
}
