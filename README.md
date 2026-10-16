# pi-scheduler

Cron-driven scheduled prompt tasks for coding agents, with [Pi](https://pi.dev)
as the built-in agent.

Pi is the management surface; the `pi-scheduler` CLI is the execution surface. A
cron entry invokes `pi-scheduler run-due`, which drives each due task through an
**Agent Adapter** — the Pi adapter creates a fully isolated **Task Session** per
run. The plugin never schedules itself and never injects task output into your
interactive Pi session.

## Features

- One-time, interval, and cron schedules
- One isolated Task Session per run, stored as its own session file
- Agent adapter layer: Pi and Claude Code built in, new agents added without touching the core
- Project-local task and run storage under `.pi/scheduler/`
- Idempotent `run-due` with a project run lock and per-run records
- Crash recovery: stale runs are reclaimed on the next invocation
- Per-task and per-project configuration overrides
- Agent tool plus slash commands for management

## Install

```bash
# From npm (recommended)
pi install npm:@fookhsu/pi-scheduler

# Or from a checkout
pi install .
```

Requires Node `>=22.19.0`: the package ships TypeScript, and the CLI runs it
through Node's built-in type stripping, so there is no build step.

Restart Pi or run `/reload` after installing. Installed with `pi install -l`,
the package is recorded in the project's `.pi/settings.json` instead of your
user settings.

## Cron setup

`run-due` is the only execution entry point, and the CLI never manages your
crontab. Add one line per project (or point `--project` at each project):

```cron
*/5 * * * * cd /path/to/project && PI_SCHEDULER_PI_BIN=/absolute/path/to/pi "$HOME/.pi/agent/npm/node_modules/.bin/pi-scheduler" run-due >> .pi/scheduler/cron.log 2>&1
```

Project installs put the binary at `.pi/npm/node_modules/.bin/pi-scheduler`
instead. If you linked it onto your `PATH`, plain `pi-scheduler` works.

Running a task spawns the `pi` executable, and cron starts jobs with a minimal
`PATH` that usually does not include it. Either set `PATH=` at the top of the
crontab, or point `PI_SCHEDULER_PI_BIN` at `pi` — the command above does the
latter. A missing `pi` is reported on the run record, not silently skipped.
Tasks pinned to the Claude Code adapter spawn `claude` instead; the same
minimal-`PATH` rule applies, with `PI_SCHEDULER_CLAUDE_BIN`.

## CLI

```text
pi-scheduler run-due [--project <path>] [--agent <id>]     # cron entry point
pi-scheduler run <taskId> [--project <path>] [--agent <id>]
pi-scheduler list [--project <path>] [--json]
pi-scheduler add --prompt <text> (--at <iso>|--every <duration>|--cron <expr>) [--agent <id>] [options]
pi-scheduler enable <taskId> | disable <taskId> | remove <taskId>
pi-scheduler prune --keep <n>
```

`--agent` selects the agent adapter (see [Agents](#agents)); it sets the task's
agent on `add` and the fallback agent on `run-due` and `run`.

Exit codes: `0` success (including "no due tasks" and "another instance holds
the lock"), `1` at least one task failed, `2` configuration or storage error.

## Pi commands

```text
/loop 30m check CI status
/loop "*/5 * * * *" check CI status
/loop @daily check CI status
/remind in 45m review the release
/remind at 15:30 check production
/schedule add 30m check CI status
/schedule add "0 9 * * 1-5" check CI status
/schedule list
/schedule enable <id>
/schedule disable <id>
/schedule run <id>
/schedule remove <id>
/schedule runs <id>
/schedule open <runId>
/schedule clear
/unschedule <id>
```

`/loop` and `/schedule add` take a schedule first: a duration (`30m`), a cron
nickname (`@daily`), or a cron expression in quotes. Quote an expression
whenever it contains spaces, otherwise its first field is read as the start of
the prompt. Nicknames are `@yearly`, `@annually`, `@monthly`, `@weekly`,
`@daily`, and `@hourly`.

`/schedule open <runId>` prints the Task Session file path and suggests
`pi --session <path>`. Task Sessions are never merged into the current session.

## Agent tool

The `schedule_task` tool supports `add`, `list`, `enable`, `disable`, `delete`,
`run`, `runs`, and `clear`.

```json
{
  "action": "add",
  "name": "check-ci",
  "prompt": "检查当前项目 CI 是否通过；如果失败请分析原因",
  "schedule": { "kind": "interval", "every": "30m" }
}
```

Deleting and clearing tasks requires interactive confirmation; creating a task does not. The `/schedule remove`, `/schedule clear`, and `/unschedule` commands ask for the same confirmation.

## Configuration and overrides

A Task Session is an ordinary Pi session: it runs in the task's `cwd` (the
project root by default) and loads that project's settings, `AGENTS.md`, skills,
and extensions. You can override what it uses at two levels.

Because the Task Runner is invoked by cron, a Task Session is always headless:
it is a `pi --print` process, so it resolves project trust exactly like any
other non-interactive Pi run — the saved decision in `~/.pi/agent/trust.json`,
otherwise `defaultProjectTrust`, which leaves a project with project-local
resources untrusted. An untrusted project contributes no `.pi/settings.json`,
skills, prompts, or extensions to its Task Sessions; run `/trust` in that
project once (or set `defaultProjectTrust` to `"always"`) to change that.
`AGENTS.md` is not gated by project trust and loads either way.

Resolution order, highest priority first:

1. Per-task fields (`agent`, `model`, `thinking`, `cwd`, `tools`).
2. Project settings in `<project>/.pi/settings.json`.
3. User settings in `~/.pi/agent/settings.json`.

### Override a run with `.pi/settings.json`

Project settings merge over global settings, so a repository can pin the model
that scheduled work uses without touching your global default:

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-flash",
  "defaultThinkingLevel": "low"
}
```

The same file can disable scheduler resources for a project that should not run
scheduled tasks, using the package-filter object form:

```json
{
  "packages": [
    {
      "source": "npm:@fookhsu/pi-scheduler",
      "extensions": [],
      "skills": []
    }
  ]
}
```

Project overrides only apply after the project is trusted; commit
`.pi/settings.json` to share them with your team. `pi config -l` opens the same
file in an editor with inherited global resources dimmed.

### Override one task

Any task can override the agent, model, thinking level, working directory, and
tool allowlist. In `.pi/scheduler/tasks.json`:

```json
{
  "id": "task_a1b2c3d4",
  "name": "daily-audit",
  "prompt": "检查 CI 并分析失败原因",
  "schedule": { "kind": "cron", "expression": "0 9 * * *" },
  "agent": "pi",
  "model": "anthropic/claude-opus-4-5",
  "thinking": "high",
  "cwd": "packages/api",
  "tools": ["read", "bash", "grep"],
  "enabled": true,
  "nextRunAt": "2026-09-11T09:00:00.000Z",
  "createdAt": "2026-09-10T09:00:00.000Z",
  "updatedAt": "2026-09-10T09:00:00.000Z"
}
```

`cwd` is resolved relative to the project root. Omitting a field falls back to
the project and user settings; omitting `tools` keeps the agent's default tool
set. Omitting `agent` uses the adapter that `run-due` selected (the built-in Pi
adapter by default).

The same overrides are available on the CLI and the Agent tool:

```bash
pi-scheduler add \
  --prompt "检查 CI 并分析失败原因" \
  --cron "0 9 * * *" \
  --agent pi \
  --model anthropic/claude-opus-4-5 \
  --thinking high \
  --cwd packages/api \
  --tools read,bash,grep
```

```json
{
  "action": "add",
  "prompt": "检查 CI 并分析失败原因",
  "schedule": { "kind": "cron", "expression": "0 9 * * *" },
  "agent": "pi",
  "model": "anthropic/claude-opus-4-5",
  "thinking": "high",
  "cwd": "packages/api",
  "tools": ["read", "bash", "grep"]
}
```

## Agents

The scheduler core — scheduling, storage, locking, run records — never imports
an agent SDK. Running a task goes through an **Agent Adapter**: a small object
that knows how to drive one Task Run in a concrete runtime.

```ts
export interface AgentAdapter {
  readonly id: string;          // e.g. "pi"
  readonly displayName: string;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}
```

Adapters register lazily, so an unused agent runtime is never loaded. Adding an
agent means adding `src/agents/<id>/adapter.ts` and one `registerAgent` line in
`src/agents/builtin.ts`; the runner, CLI, storage, and Pi surface stay
untouched. The Pi adapter lives in `src/agents/pi/` together with the Pi
extension, tools, and slash commands.

The Pi adapter drives a Task Run by spawning `pi --print --session <file>` in the
task's `cwd`, and reports the printed answer as the run summary. It imports no
Pi SDK, so a Task Run works from a bare `node` process — which is what cron is.
The spawned `pi` is also the runtime that owns the model, credentials, and
project-trust rules, so a scheduled run behaves like any other non-interactive
Pi run. The only requirement is that `pi` be reachable: see
[Configuration and overrides](#configuration-and-overrides) and
`PI_SCHEDULER_PI_BIN`.

### Claude Code

The Claude Code adapter drives a Task Run by spawning
`claude --print --output-format json` in the task's `cwd`, and records the JSON
result — final message, Claude Code session id, usage — as the run's session
record at `.pi/scheduler/sessions/<taskId>/<runId>.json`. Claude Code keeps its
own transcript; `claude --resume <session_id>` reopens it.

Two behavior differences from the Pi adapter:

- A headless Claude Code run cannot approve permission prompts, so a tool the
  task did not allow is denied, not asked. Set `tools` on tasks that need to
  write or execute: the task's tool list maps to `--allowedTools`.
- `thinking` has no Claude Code equivalent and is ignored.

The `claude` binary is resolved like `pi`: `PI_SCHEDULER_CLAUDE_BIN` first,
then `$PATH`. Pin it in the crontab the same way.

Pi remains the management surface: `/schedule`, `/loop`, and `/remind` still
manage the same store, and `schedule_task` gains an `agent` field to pin a task
to a specific adapter.

## Storage and recovery

```text
<project>/.pi/scheduler/
├── tasks.json                        # versioned task definitions, 0600
├── run.lock                          # project-wide run lock, 0600
├── runs/<runId>.json                 # one record per run, 0600
└── sessions/<taskId>/<runId>.jsonl   # the Task Session, forced to 0600
```

The whole directory is gitignored. Every scheduler file, including Task Session
JSONL files, is written with `0600` permissions.

- A task stores a prompt and a time rule, never a shell command.
- Task definitions and run records are separate; run state is never inlined into
  `tasks.json`.
- `run-due` takes `run.lock`, executes due tasks serially, and advances each
  task's `nextRunAt` from the current time. Missed recurring periods collapse
  into one catch-up run.
- A one-shot task is terminal after its first attempt: success disables it,
  failure does not retry, and a run that passed the grace window (default 5
  minutes) is recorded as `missed` and needs `run <id>`.
- A run still marked `running` after the timeout (default 30 minutes) is
  reclaimed as `error` on the next invocation.

## Development

```bash
npm install
npm run check    # typecheck + build + tests
```

`npm run build` compiles `src/` to `dist/` with `tsc -p tsconfig.build.json`.
`bin/pi-scheduler.mjs` and the `pi` manifest both point at `dist/`, because Node
refuses to strip types for files under `node_modules` — a published package
cannot run its own `.ts` sources.

`src/agents/` is the agent adapter layer: `types.ts` is the adapter contract,
`registry.ts` resolves adapters, `builtin.ts` wires the built-ins, and
`pi/` holds everything Pi-specific (adapter, extension, tools, commands), and
nothing under `pi/` is imported by the CLI path except the adapter, which spawns
`pi --print` rather than linking the SDK.
Everything else in `src/` is agent-agnostic: the Task Runner, stores, locking,
and CLI.

## Releasing

The package follows the [Pi package](https://pi.dev/docs/latest/packages)
conventions: the `pi-package` keyword and a `pi` manifest in `package.json`.

```bash
npm run check        # typecheck + build + tests
npm pack --dry-run   # inspect the published file list
npm publish          # prepublishOnly re-runs check
```

`files` ships `bin/`, `dist/`, `skills/`, and `src/`. The `dist/` build is what
makes a published install runnable, and `src/` ships alongside it so the source
maps resolve. `@earendil-works/pi-coding-agent` stays an optional peer: only the
extension imports it, and Pi hands its own copy to extensions, so an install of
the scheduler never needs a second SDK.
