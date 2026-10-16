---
name: scheduler
description: Create and manage cron-driven prompt tasks for a project. Use when the user wants something to run later or on a recurring schedule, or to inspect why a scheduled task did not run.
---

# Scheduled Tasks

A schedule task is a stored prompt plus a time rule. Tasks are project-scoped in
`.pi/scheduler/tasks.json`; each run opens its own isolated Pi Task Session.
Execution is owned by an external scheduler that invokes
`pi-scheduler run-due`, so Pi never runs tasks in the background by itself.
Mention the cron entry when the user expects unattended runs.

## Drive the store

In Pi, use the `schedule_task` tool or the `/loop`, `/remind`, and `/schedule`
commands.

In any other harness, shell out to the CLI, which reads and writes the same
store with the same rules:

```bash
pi-scheduler add --prompt "<text>" (--at <iso> | --every <duration> | --cron "<expr>") [options]
pi-scheduler list [--json]
pi-scheduler enable <taskId> | disable <taskId> | remove <taskId>
pi-scheduler run <taskId>
pi-scheduler prune --keep <n>
```

If `pi-scheduler` is not on `PATH`, call the installed binary directly:
`"$HOME/.pi/agent/npm/node_modules/.bin/pi-scheduler"` for a global install or
`.pi/npm/node_modules/.bin/pi-scheduler` for a project install.

## Agents

Tasks run through an agent adapter: `pi` (default) or `claude` (Claude Code,
driven headless via `claude --print`). Pin one per task with `--agent` on `add`,
`run`, and `run-due`, or the `agent` field in `tasks.json`. A Claude Code run
needs the `claude` CLI on `PATH` (`PI_SCHEDULER_CLAUDE_BIN` under cron) and
treats the task's `tools` list as an allowlist, because headless runs cannot
approve permission prompts. `thinking` is ignored on Claude Code.

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
- Explain the task ID and next run time after creating a task.
- A Task Session is separate from this session and its results are never
  injected here. Inspect them with the `runs` action or `pi-scheduler list`, and
  tell the user they can open one with `pi --session <path>`.
