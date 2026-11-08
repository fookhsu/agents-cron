# Changelog

All notable changes to agents-cron are documented here. After each upgrade
the Pi extension shows the sections between your previous version and the
new one as an in-terminal notice; `/schedule changelog` shows this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [0.18.0] - 2026-11-08

### Changed

- One vocabulary for every surface. The CLI's formatters — the interval as
  `30m`/`2h`/`1d` rather than raw milliseconds, the compact ISO timestamp,
  the task line, the detailed task block, the run line — now live in
  `src/format.ts`, and the `schedule_task` tool, the slash commands, their
  completions, and the dashboard's schedule label all read from it. Before
  this, `tools.ts` and `pi/format.ts` each had their own `formatTask` /
  `formatRun` / `formatSchedule` and had already drifted: the same task
  printed `next 2026-09-01T10:00:00.000Z` in one and a locale date in the
  other, and `every 1800000ms` in the tool while the CLI said `every 30m`.
  `schedule_task show` now returns the CLI's `show` block verbatim, and its
  `list`/`runs` lines are the CLI's lines.
- The dashboard's JSON is machine-readable: `/api/runs` carries `total`,
  `returned`, `has_more`, and (when truncated) `next_limit`, so
  `?limit=1` against a three-run task states the truncation instead of
  implying it; `/api/overview` carries `total`, `enabled`, and `failures`
  beside the task array; and every non-2xx answers
  `{"error": {"code", "message"}}`. A corrupt registry now answers `503` with
  `corrupt_registry` instead of an empty task list that reads as "nothing
  scheduled".
- `--notify-to` is the one name, on both surfaces: the CLI accepts `--to` as
  its short spelling (previously CLI-only `--notify-to`, Pi-only `--to`), and
  a command passing both exits `2` instead of silently picking one.
  `/schedule export` accepts `--out <file>` as well as a bare positional, so
  the destination is spelled the same way on both sides.
- `registry_lock_busy` is now its own code (exit `3`, "nothing was saved"),
  distinct from `lock_busy` (the project Run Lock, exit `0` by skipping). The
  two "lock is busy" outcomes were the same word for two opposite meanings.

### Fixed

- `import` warns about an agent id no adapter answers to, exactly like `add`
  and `set`, and `--dry-run` warns too — previewing is when you most want to
  know the imported task would never run here (issue #14).
- The unknown-agent warning no longer exempts the literal `"fake"`: the
  exemption was a test double's name leaking into product code. The check now
  judges against the agent registry actually in play, so a test injects its
  own and the assertion is about behaviour, not a carve-out (issue #14).

### Documented

- README § "What the CLI promises a machine" states the decision behind
  registry faults being local: no notification channel is global, and a
  registry that cannot be read cannot name a project to route by, so a corrupt
  registry or a busy Registry Lock reaches the user through the cron log, any
  failing command, and the dashboard's coded `503` — never by push. The two
  locks get their own paragraph (issue #13).

## [0.17.0] - 2026-11-08

### Changed

- The CLI's output is now a contract written for agents, not a human reading
  a terminal. Bare `agents-cron` answers with the task list
  instead of usage; every mutation prints the state it produced (the updated
  task line, the remaining count) and closes with a `next: agents-cron …`
  line; `list` and `runs` carry the true total and announce what `--limit`
  hid; empty results state what is empty and what to run instead, still at
  exit `0`.
- Unknown input is refused instead of silently ignored: an unknown flag, a
  flag a command does not take, a stray positional, or `--flag=value` on a
  boolean exits `2` naming what the command accepts. Previously `list
  --bogus x` and `add --prompt x --at 2026-9-1` both succeeded while doing
  something other than what was written.
- Errors are one line on stderr — `error: <code>: <message>` — with a code a
  script can branch on, and nothing on stdout. Exit codes separate the two
  faults they used to conflate: `2` is now bad input only (flags, arguments,
  invalid schedule, unknown task id), and a machine at fault is `3` — a
  corrupt or unsupported store (`corrupt_store`, `corrupt_registry`), a busy
  run lock (`lock_busy`), no terminal for `setup-notify` (`no_tty`). `1`
  stays "a run or notification failed". Cron's contract is unchanged (it only
  distinguishes zero from non-zero). The store and registry modules now throw
  `EnvironmentError` for their own failures instead of a bare `Error` that the
  CLI had to classify by guessing.
- `nextRunAt` and other timestamps print in compact ISO 8601 (whole seconds
  lose `.000`), and task lines say `never run` instead of omitting the run.

### Added

- `agents-cron runs <taskId> [--limit <n>] [--json]`: a task's run history,
  newest first, with its errors on the line and a status breakdown — the
  observation `run` and `run-due` now point at, instead of making a caller
  dig through `.agents/cron/runs/`.
- `--json` on every command that has a JSON shape, including mutations
  (`created` / `updated` / `removed` + remaining count). Where no shape exists
  (`setup-notify`, `migrate-sessions`) the flag is refused rather than
  accepted and ignored.
- `add` warns on stderr when `--agent` names an adapter that is not
  registered, so a typo fails at write time instead of at the next 3 a.m. run.

### Fixed

- `agents-cron add --prompt x --every 1h --agent <typo>` used to store the
  typo silently and fail on every run afterwards.

## [0.16.2] - 2026-11-08

### Changed

- The scheduler skill states what is *not* a task (issue #9): a standing,
  message-driven role — serve this inbox, judge what arrives, keep watching
  until I say stop — has no time rule that could express it, so it belongs to
  `spawn_pod` in agents-pod, woken by its admission owner and never by the
  clock. A task is used only when the trigger is a time. The rule sits with the
  definition of a task, because the skill body outweighs the one-line guidance
  agents-pod contributes to `spawn_pod`, and a missing owner on this side is
  what let a standing ask become a task that read the clock. A hybrid ask is
  decomposed on the same two axes (trigger × work) and hands its work over: the
  task owns the clock, the pod owns the work, and the handover takes an Inbox
  Item or an `agents-pod wake`, never a clock inside the pod's goal.
- A gate in `tests/packaging.test.ts` keeps that paragraph in place — the
  not-a-task rule must follow the task definition, name `spawn_pod` and the
  wake its owner gives it, and ship in the packed tarball. Assertions are
  structural, so the prose stays free to be rewritten.

## [0.16.1] - 2026-11-04

### Fixed

- `/reload`, `/new`, `/resume`, and `/fork` no longer take `/schedule`,
  `/loop`, `/remind`, and `schedule_task` with them (issue #10). Every runtime
  replacement re-imports the extension into a fresh command and tool registry
  while the process keeps its `globalThis`, so the guard that keeps a second
  installed copy inert (the `@fookhsu/pi-scheduler` shim) was still set and the
  reloaded copy stayed silent — restarting Pi was the only way to get the
  commands back. The guard is now released on `session_shutdown`, so it claims
  a runtime instead of the process.

## [0.16.0] - 2026-11-02

### Added

- Per-task model configuration, before or after creation. `/loop`, `/remind`,
  and `/schedule add` accept trailing `--model <id>`, `--thinking <level>`,
  and `--agent <id>` flags; `/schedule set <id> <flags>` reconfigures an
  existing task (same fields plus `--name`, `--cwd`, `--tools`, `--notify`,
  `--to`), a value of `-` clearing a field back to the project and user
  defaults. `agents-cron set <taskId> [options]` brings the same to the CLI
  (an empty value clears), and `schedule_task` gains an `update` action.
  `--thinking` is validated when a task is written — `off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max` — so a typo fails the `set`, not every
  3 a.m. run. Completions follow: `/schedule set` completes ids then its
  flags, and `--thinking <level>` completes everywhere it is accepted.
  `/schedule show` and `schedule_task show` now list agent, model, thinking,
  cwd, and tools alongside the notify routing.
- Detached dashboard lifecycle: `agents-cron dashboard start|stop|status` and
  `/schedule dashboard [start|stop|status]` run the read-only dashboard as a
  child that outlives the shell and the Pi session, registered per project in
  `.agents/cron/dashboard.json` (logs in `.agents/cron/dashboard.log`). Stop
  verifies the port still answers like this dashboard before signaling, so a
  recycled PID is left alone — the refusal names what that pid currently
  runs, so the user can judge it themselves; a registration whose process
  died is cleaned up on the next status read.

## [0.15.0] - 2026-10-30

### Added

- Argument completion for the Pi slash commands: `/schedule ` suggests
  every action, then real task ids (`enable`, `disable`, `run`, `remove`,
  `show`, `runs`) and recent run ids (`open`) read from the store — foreign
  projects' tasks say where they live; `/loop` and `/schedule add` suggest
  cron nicknames while the spec starts with `@`; `/loop`, `/remind`, and
  `/schedule add` complete trailing `--to`/`--notify-to` (channel ids from
  the project's notify config, comma-list aware) and `--notify` (its three
  levels). Completion never throws and never writes — a broken store just
  means no suggestions.

## [0.14.0] - 2026-10-28

### Added

- Task export and import (ADR 0009): `agents-cron export [--out <file>]
  [--all] [taskId...]` writes a versioned JSON file of task definitions —
  no ids, project bindings, registry state, or run history — and
  `agents-cron import <file> [--dry-run]` creates each entry as a fresh task
  bound to the current project, disabled until reviewed. An entry counts as
  a duplicate only when name, prompt, and schedule all match, so importing
  the same file twice adds nothing. `/schedule export [file] [--all]` and
  `/schedule import <file>` bring the same to Pi.

### Fixed

- The command surface now matches reality: `clear` is documented (it
  existed but was absent from usage and the README), `prune --keep` is
  shown as the optional flag it always was (default 20, shared with the
  runner's auto-prune), and `/loop` and `/schedule add` share one creation
  path instead of two copies of the same logic.

### Removed

- The `/unschedule` command and the `/schedule delete` alias —
  `/schedule remove <id>` is the one delete path (the agent tool's `delete`
  action is unchanged).

## [0.13.2] - 2026-10-28

### Fixed

- Usage and parse errors now teach the accepted syntax instead of leaving it
  to guesswork: durations name their units (`30s`, `5m`, `2h`, `1d`) in the
  `/remind`, `/loop`, and `/schedule add` usage lines, a bad cron expression
  shows a field example (`"0 9 * * 1-5"`), a bad `--at`/`runAt` shows an ISO
  8601 sample, and a schedule-less `add` spells out all three forms

## [0.13.1] - 2026-10-28

### Added

- An unconfigured project now gets a one-line stderr reminder when a run is
  worth announcing (error/missed at the default level), instead of staying
  silent — configuring channels remains fully optional, never forced

## [0.13.0] - 2026-10-28

### Added

- `system` notification channel: a finished run pops a desktop notification —
  macOS Notification Center (optional `sound`) or Linux `notify-send`. No
  external service, ideal for local-only reminders
- Project-wide default routing: `"defaultTo": ["feishu"]` in
  `.agents/cron/config.json` routes every task that names no channels of its
  own; a task's `notifyTo` still wins
- Per-task notification routing: `notifyTo` names the channel ids a task
  announces on — `/remind in 45m review --to feishu --notify always`,
  `agents-cron add --notify-to feishu,mail`, or `notifyTo` on the
  `schedule_task` tool. A task without routing still notifies every configured
  channel; unknown ids warn at creation (from every creator — CLI, Pi commands,
  and the tool alike) and are skipped at dispatch, never fatally

### Fixed

- A config-declared `"format": "feishu"` webhook was silently downgraded to
  the generic JSON body at load, so Feishu bots rejected every delivery;
  the setup wizard's own output hit this. `text` and `feishu` now both
  survive loading

## [0.12.1] - 2026-10-27

### Fixed

- Commands run from the registry's own home directory no longer mistake the global registry for a legacy v1 store and fail with "Unsupported scheduler file format"

## [0.12.0] - 2026-10-26

### Added

- `show <taskId>` CLI command prints one task in full — scheduling facts, run counters, and the prompt verbatim (`--json` for the raw task)
- `show` action on the `schedule_task` tool and `/schedule show <id>` print a task's prompt inside Pi
- Dashboard: clicking a task reveals its prompt behind a collapsed "show prompt" toggle above the run history

## [0.11.0] - 2026-10-26

### Added

- In-terminal update notices: after an upgrade, the extension lists the new features and fixes once, on the next session start
- `/schedule changelog` prints this file from inside Pi
- `/schedule help` lists every action; unknown actions point at it

## [0.10.2] - 2026-10-23

### Added

- `migrate-sessions` CLI command carries legacy Task Session transcripts into Pi's session store
- Opt-in Task Session placement in Pi's session store
- Interactive `setup-notify` wizard for email and Feishu channels

### Fixed

- The setup-notify wizard survives fresh projects, WSL stdin, and reports honest stage counts

## [0.10.1] - 2026-10-22

### Fixed

- Pi shows the bare `agents-cron` extension label again (root `index.mjs` entry)

## [0.10.0] - 2026-10-22

### Added

- Per-run Markdown reports, written and pruned with their runs
- Feishu webhook notifications, alongside generic webhook and email

### Fixed

- A Feishu business rejection now fails the send instead of reporting success

## [0.9.1] - 2026-10-22

### Fixed

- `agents-cron --help` and `-h` work instead of demanding a value
- Interval schedules render in human units (30m, 1h) instead of raw milliseconds

## [0.9.0] - 2026-10-22

### Added

- Global task registry (ADR 0007): tasks live machine-wide, run artifacts stay project-local
- `schedule_task` deferred behind `tool_search` discovery

## [0.8.0] - 2026-10-18

### Changed

- Renamed from `@fookhsu/pi-scheduler` to `agents-cron`
- Store moved to `.agents/cron/` with one-time migration from `.pi/scheduler/`

### Added

- Run notifications via webhook and email
- The extension stays inert when two copies load in one process

[Unreleased]: https://github.com/fookhsu/agents-cron/compare/v0.18.0...HEAD
[0.18.0]: https://github.com/fookhsu/agents-cron/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/fookhsu/agents-cron/compare/v0.16.2...v0.17.0
[0.16.2]: https://github.com/fookhsu/agents-cron/compare/v0.16.1...v0.16.2
[0.11.0]: https://github.com/fookhsu/agents-cron/compare/v0.10.2...v0.11.0
[0.10.2]: https://github.com/fookhsu/agents-cron/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/fookhsu/agents-cron/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/fookhsu/agents-cron/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/fookhsu/agents-cron/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/fookhsu/agents-cron/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/fookhsu/agents-cron/compare/v0.7.0...v0.8.0
