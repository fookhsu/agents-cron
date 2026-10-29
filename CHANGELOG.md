# Changelog

All notable changes to agents-cron are documented here. After each upgrade
the Pi extension shows the sections between your previous version and the
new one as an in-terminal notice; `/schedule changelog` shows this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/fookhsu/agents-cron/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/fookhsu/agents-cron/compare/v0.10.2...v0.11.0
[0.10.2]: https://github.com/fookhsu/agents-cron/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/fookhsu/agents-cron/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/fookhsu/agents-cron/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/fookhsu/agents-cron/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/fookhsu/agents-cron/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/fookhsu/agents-cron/compare/v0.7.0...v0.8.0
