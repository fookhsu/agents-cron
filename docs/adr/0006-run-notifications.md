# ADR 0006: Run notifications as a second adapter family

Date: 2026-10-18
Status: Accepted

## Context

A scheduled task that fails at 3am is indistinguishable from one that never
ran, unless someone reads run records. Users asked for push notifications,
email in particular. The temptation is to bolt delivery onto the Task Runner,
but delivery is a runtime concern with its own providers (webhook vendors,
SMTP), exactly like agent execution was before the adapter layer (ADR 0002).

## Decision

Notifications are the second adapter family, symmetric to agent adapters:

- `src/notify/` owns channel types (`webhook`, `email`), a registry
  (`notifiersFor`), and delivery. Nothing else in the core knows a channel
  type exists.
- The Task Runner hooks the single choke point where a run record becomes
  terminal (`executeTask`'s two branches and `markMissed`), right after the
  record is written. It offers the run to every channel and moves on.
- Configuration is user-authored in `.agents/cron/config.json` — the store
  stays the only shared state, and a malformed config degrades to "no
  channels" with a stderr warning instead of failing the cron pass.
- Severity is a level, not a boolean: project default `on` (`error` by
  default), overridden per task by a `notify` field. `missed` counts as an
  error; `skipped` never notifies.
- Secrets never enter the config file: the SMTP password is read from an
  environment variable (`AGENTS_CRON_SMTP_PASSWORD` or the channel's
  `passwordEnv`).
- Delivery is best effort with a 10-second budget per channel and parallel
  dispatch; failures are one stderr line each and never fail the run being
  reported. A notification problem is a notification problem, not a task
  failure.
- `nodemailer` is an optional dependency, lazily imported only when an email
  channel is configured: projects that only use webhooks keep the zero-SMTP
  footprint.

## Consequences

- New channels (Telegram, SMS, Sentry…) are one file plus one branch in
  `notifierFor`, touching nothing else.
- `agents-cron test-notify` exercises channels with a synthetic run, because a
  notification path you cannot test is one you discover broken at 3am.
- The run record stays notification-unaware in v1; if "did it notify?" needs to
  be answerable from the dashboard later, add a `notified` field then — not
  speculatively now.

## Amendment (2026-10-27)

Two commits (`9637204`, `f10544a`) extended the Decision without changing its
shape:

- A third channel type, `system`, joined `webhook` and `email`: desktop
  notifications via macOS Notification Center (`osascript`) or Linux
  `notify-send`. It followed the Consequences rule exactly — one file
  (`src/notify/system.ts`) plus one branch in `notifierFor`.
- Routing became a second dimension, symmetric to severity: the project config
  may set `notifications.defaultTo`, a task may set `notifyTo`, and dispatch
  resolves `task.notifyTo ?? config.defaultTo` — falling through to every
  configured channel when neither names one, exactly like
  `task.notify ?? config.on`.
- Unknown channel ids warn on stderr and are skipped at dispatch, never
  fatally; `addTask` repeats the same warning at creation time so every
  creator (CLI, Pi commands, the `schedule_task` tool) catches typos before
  the first 3 a.m. run.
