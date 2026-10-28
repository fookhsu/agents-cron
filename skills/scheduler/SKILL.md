---
name: scheduler
description: Create and manage cron-driven prompt tasks for a project. Use when the user wants something to run later or on a recurring schedule, or to inspect why a scheduled task did not run.
license: AGPL-3.0
---

# Scheduled Tasks

A schedule task is a stored prompt plus a time rule. Tasks live in the global
registry `~/.agents/cron/tasks.json`, each bound to the project it was created
in (`projectDir`); run records and Task Sessions stay in that project's
`.agents/cron/`. Each run opens its own isolated Pi Task Session. Execution is
owned by an external scheduler that invokes `agents-cron run-due`, so Pi never
runs tasks in the background by itself. Mention the cron entry when the user
expects unattended runs.

## Install

The CLI is the npm package `agents-cron` and needs Node `>= 22.19`:
`npm install -g agents-cron`. In Pi, install the whole package instead —
extension, tool, and this skill — with `pi install npm:agents-cron`.

## Drive the store

In Pi, use the `schedule_task` tool or the `/loop`, `/remind`, and `/schedule`
commands. The tool is exposed with `deferred` exposure: it is not declared to
the model up front, so find it with `tool_search` (for example
`tool_search("schedule task")`) before the first call; the extension already
keeps `tool_search` active for this.

In any other harness, shell out to the CLI, which reads and writes the same
store with the same rules:

```bash
agents-cron add --prompt "<text>" (--at <iso> | --every <duration> | --cron "<expr>") [options]
agents-cron list [--json]        # current project's tasks first, then all others
agents-cron show <taskId> [--json]  # one task in full, prompt included
agents-cron enable <taskId> | disable <taskId> | remove <taskId>
agents-cron clear                    # remove every task bound to the current project
agents-cron export [--out <file>] [--all] [taskId...]   # definitions as JSON; import starts disabled
agents-cron import <file> [--dry-run]
agents-cron prune [--keep <n>]       # all projects unless --project; default keep 20
agents-cron run <taskId>
agents-cron dashboard [--port <n>]
agents-cron test-notify [--channel <id>]
```

IDs resolve across the whole registry, so these commands manage any task from
any directory. One global crontab line (`agents-cron run-due --all`) drives
every project; a per-project line still runs only that project.

The dashboard is a read-only local web view (`127.0.0.1:7383` by default) of
tasks, run history, and per-run summaries, errors, and session records — the
quickest way to see why a task did not run.

Runs can also push notifications through `.agents/cron/config.json` channels —
SMTP email (QQ/Foxmail-style), webhook (including the Feishu group-bot format
`"format": "feishu"`; the bot's keyword must be `task`, and signature
security is not supported), and `system` desktop notifications (macOS
Notification Center via osascript, Linux via notify-send — zero setup, ideal
for local-only reminders) — error-only by default, and a task may override
the level (`--notify always`) and route itself to specific channels
(`--to feishu` in Pi, `--notify-to feishu,mail` on the CLI). A project may
also set a default route: `"defaultTo": ["feishu"]` applies to every task
that names no channels of its own. First-time setup is guided: run
`agents-cron setup-notify` with the user; it opens the mail and Feishu
consoles, captures the SMTP 授权码 and webhook URL, writes config.json plus
`.agents/cron/notify.env` (secrets never enter config.json), wires the shell,
and live-tests each channel. Verify an existing setup with
`agents-cron test-notify`. Channels are never forced: a run worth announcing
with none configured only gets a one-line stderr reminder (in the cron log).

When the user wants to perceive a task's output, resolve its notification
before creating it: read the task project's `.agents/cron/config.json`; if
`notifications.defaultTo` names channels, route to them without asking; if
channels exist but no default does, ask which ones (list their ids); if there
are no channels yet, offer `agents-cron setup-notify` or a `system` channel.
Tasks created so the user can see the result should carry `--notify always`
(reminders included — the default level announces only failures). Confirm the
chosen routing back to the user with the task id and next run time.

If `agents-cron` is not on `PATH`, call the installed binary directly:
`"$HOME/.pi/agent/npm/node_modules/.bin/agents-cron"` for a global install or
`.pi/npm/node_modules/.bin/agents-cron` for a project install.

## Agents

Tasks run through an agent adapter: `pi` (default), `claude` (Claude Code,
driven headless via `claude --print`), or `codex` (driven headless via
`codex exec`). Pin one per task with `--agent` on `add`,
`run`, and `run-due`, or the task's `agent` field in the registry. A Claude Code run
needs the `claude` CLI on `PATH` (`AGENTS_CRON_CLAUDE_BIN` under cron) and
treats the task's `tools` list as an allowlist, because headless runs cannot
approve permission prompts. A Codex run needs the `codex` CLI on `PATH`
(`AGENTS_CRON_CODEX_BIN` under cron); its sandbox depends on the task's
`tools`: none runs read-only, any runs workspace-write. `thinking` is ignored
on both.

## Rules

- Use `once` with an ISO timestamp, `interval` with a duration of at least 1
  minute such as `30m`, or `cron` with a 5- or 6-field expression or a nickname
  (`@daily`, `@hourly`, `@weekly`, `@monthly`, `@yearly`, `@annually`).
- `/loop` and `/schedule add` accept a duration, a nickname, or a quoted cron
  expression (quote it whenever it contains spaces).
- Deleting and clearing tasks requires interactive confirmation in Pi; creating
  a task does not.
- Resolve notifications when creating a task the user wants to hear about:
  apply `notifications.defaultTo` if set, else ask from the configured
  channels, else offer `setup-notify` or a `system` channel; add
  `--notify always --to <ids>` (Pi) or `--notify always --notify-to <ids>`
  (CLI) to the created task.
- Tasks contain prompts for Pi; they never contain arbitrary shell commands.
- Do not create duplicate tasks when an existing task already represents the
  same request.
- Ask the user to clarify any missing or ambiguous timing; never guess a
  schedule.
- Explain the task ID and next run time after creating a task.
- A Task Session is separate from this session and its results are never
  injected here. Inspect them with the `runs` action or `agents-cron list`,
  read a task's prompt with the `show` action or `agents-cron show <id>`, and
  tell the user they can open one with `pi --session <path>`.
