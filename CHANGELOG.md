# Changelog

All notable changes to agents-cron are documented here. After each upgrade
the Pi extension shows the sections between your previous version and the
new one as an in-terminal notice; `/schedule changelog` shows this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
