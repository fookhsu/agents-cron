---
name: scheduler
description: Create and manage cron-driven prompt tasks for a project. Use when the user wants something to run later or on a recurring schedule, or to inspect why a scheduled task did not run.
license: MIT
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
agents-cron enable <taskId> | disable <taskId> | remove <taskId>
agents-cron run <taskId>
agents-cron prune --keep <n>     # all projects unless --project
agents-cron dashboard [--port <n>]
agents-cron test-notify [--channel <id>]
```

IDs resolve across the whole registry, so these commands manage any task from
any directory. One global crontab line (`agents-cron run-due --all`) drives
every project; a per-project line still runs only that project.

The dashboard is a read-only local web view (`127.0.0.1:7383` by default) of
tasks, run history, and per-run summaries, errors, and session records — the
quickest way to see why a task did not run.

Runs can also push notifications through `.agents/cron/config.json` channels
(webhook or SMTP email), error-only by default; verify a setup with
`agents-cron test-notify` before relying on it.

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
- Tasks contain prompts for Pi; they never contain arbitrary shell commands.
- Do not create duplicate tasks when an existing task already represents the
  same request.
- Ask the user to clarify any missing or ambiguous timing; never guess a
  schedule.
- Explain the task ID and next run time after creating a task.
- A Task Session is separate from this session and its results are never
  injected here. Inspect them with the `runs` action or `agents-cron list`, and
  tell the user they can open one with `pi --session <path>`.
