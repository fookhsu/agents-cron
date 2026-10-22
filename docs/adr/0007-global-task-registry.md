# ADR 0007: Global task registry, project-local artifacts

Date: 2026-10-22
Status: Accepted (implemented in 0.9.0)

Supersedes the original per-project registry design (`docs/scheduler-spec.md`,
since removed — the README is now the user-facing authority for storage layout
and crontab setup). Everything else — the runner, adapters, notifications —
is untouched.

## Context

Tasks live in per-project stores (`<project>/.agents/cron/tasks.json`). Each
project needs its own crontab line, and a task created in one directory is
invisible from every other directory unless you pass `--project`. With tasks
spread across projects, "what is scheduled anywhere?" has no single answer,
and every new project means another crontab line to install.

The decision: move task definitions and execution status into one global
store, keep execution artifacts in the project, and show local tasks first in
listings.

## Decision

### One registry, "local" is a view (Q1)

All task definitions live in a single global registry at
`~/.agents/cron/tasks.json`. Every task persists the project it belongs to;
"local tasks" means a filter-and-sort of the registry by `projectDir`, not a
second store. The dual-store alternative (per-project AND global stores merged
at read time) is rejected: it doubles storage, enable/remove semantics, and
migration paths.

### Split: registry state vs run artifacts (Q2)

- The registry holds the **authoritative scheduling state** per task:
  `nextRunAt`, `enabled`, plus `lastRunAt`, `lastStatus`, `successCount`,
  `errorCount`, `missedCount`.
- The project store holds **append-only artifacts**: full run records
  (`runs/*.json`) and session transcripts (`sessions/**/*.jsonl`). Artifacts
  never carry scheduling state.
- Crash rule: prefer a missing artifact over a duplicate execution. The
  registry advances `nextRunAt` as the authority; a crash after a run finished
  but before its local record was written loses one artifact line, never
  re-executes the task. Counters may drift and can be rebuilt from local runs.

### Task-to-project binding (Q4)

- `projectDir` is a required field: absolute path, resolved at `add` time.
  Default is the cwd the command ran in; `--project` overrides it. It decides
  where artifacts are written, which run lock serializes execution, and which
  notification config applies.
- The existing `--cwd` stays a run-time working-directory override only,
  defaulting to `projectDir`. It never relocates the store or the binding.
- If `projectDir` no longer exists (repo deleted or moved), runs of that task
  error in the registry; the task stays enabled and is visibly marked in
  `list`. Recurring tasks still advance to their next occurrence (one error
  per interval, not one per tick); one-shot tasks are left for the grace
  window. The directory-existence check happens **before** acquiring the
  project run lock — the lock's `mkdir -p` would otherwise resurrect the
  deleted directory.

### Execution: one crontab line, two lock layers (Q3)

- The end-state crontab has **one line**: `agents-cron run-due --all` — no
  `cd`, no `--project`. Global mode groups due tasks by `projectDir` and
  executes group by group, each under that project's run lock.
  *Amendment (implementation):* the global switch is an explicit `--all`
  flag rather than "bare `run-due`", because a bare `run-due` inside a
  directory keeps its legacy meaning (that project's tasks only) — silent
  cwd-dependent behavior switches would be surprising interactively.
- Locks: a short-lived **registry lock** (`~/.agents/cron/registry.lock`)
  serializes read-modify-write of `tasks.json`; the existing per-project
  `run.lock` is held while executing that project's tasks. Worst-case blocking
  is one project — same semantics as today, no global head-of-line blocking by
  a 30-minute task.

### Migration (Q5, Q8)

- **Lazy**: any command touching a project that still has a v1 store imports
  its tasks into the global registry (backfilling `projectDir` from that
  project), then renames the local file to `tasks.json.imported.<ts>`.
  `runs/`, `sessions/`, `config.json` are untouched. Rollback = rename back
  and restore the old crontab lines.
- **Old crontab lines keep working** during migration: `run-due` run inside
  project X reads the global registry filtered to X. Combined with the
  per-project lock, a legacy line and the new global line cannot
  double-execute within the same tick. Documentation states the end state:
  replace N lines with 1.
- An ID collision at import (astronomically unlikely) aborts that import with
  a loud error rather than silently renaming.

### Counter semantics (Q9)

`lastRunAt`, `lastStatus`, and the counters include **manual runs** — a run is
a run; the `trigger` field distinguishes them. Manual `run` never touches
`nextRunAt` (unchanged from today). `lastStatus` is the terminal status of the
most recent run of any trigger.

### Listing and dashboards (Q6, Q10)

- `list` prints one ordered list: the current project's tasks first (by
  `nextRunAt`), a blank line, then other projects grouped by absolute path
  (A→Z), tasks by `nextRunAt` within each group. Project column shows the
  directory basename, disambiguated to the full path when two projects share a
  basename. Tasks whose `projectDir` is missing get a `⚠ missing directory`
  suffix — computed at read time, never stored.
- `--json` is a flat array; each task carries `projectDir`, the counters, and
  `lastStatus`.
- No `--all` flag: the default already shows everything, just ordered.
- `dashboard` becomes a global view grouped by project.

### Cross-directory operations (Q11)

`run`, `enable`, `disable`, `remove` act on any registry task from any
directory; `run` acquires the owning project's lock and writes artifacts
there. `prune` without `--project` walks every project in the registry.
`test-notify` reads the owning project's notification config (config follows
the project, like all artifacts).

## Schema

### Global registry: `~/.agents/cron/tasks.json` (version 2)

```json
{
  "version": 2,
  "tasks": [
    {
      "id": "task_a1b2c3d4",
      "projectDir": "/home/edy/work/agents-cron",
      "name": "nightly-audit",
      "prompt": "检查 CI 并总结失败原因",
      "schedule": { "kind": "cron", "expression": "0 3 * * *", "timezone": "Asia/Shanghai" },
      "enabled": true,
      "nextRunAt": "2026-10-23T03:00:00.000Z",
      "agent": "pi",
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "low",
      "cwd": "/home/edy/work/agents-cron/packages/app",
      "tools": ["read", "bash"],
      "notify": "error",
      "lastRunAt": "2026-10-22T03:00:41.000Z",
      "lastStatus": "success",
      "successCount": 42,
      "errorCount": 3,
      "missedCount": 0,
      "createdAt": "2026-09-01T08:00:00.000Z",
      "updatedAt": "2026-10-22T03:00:41.000Z"
    }
  ]
}
```

Field notes:

- `projectDir` (new, required): the belongs-to binding — artifacts, lock, and
  notification config all follow it. Absolute, resolved at `add`.
- `cwd` (existing, optional): run-time working-directory override; defaults to
  `projectDir`. Never used to locate state.
- `lastRunAt` / `lastStatus` / `successCount` / `errorCount` / `missedCount`
  (new): registry state. `lastStatus` uses the existing `RunStatus` values.
- All other fields are unchanged from v1. Only `projectDir` and the five state
  fields are new; `version: 2` gates the required `projectDir`.
- Permissions stay 0600 like every other scheduler file.

### Project store: `<project>/.agents/cron/` (artifacts only)

```
<project>/.agents/cron/
├── tasks.json.imported.<ts>   # renamed v1 store after import; rollback artifact
├── run.lock                   # per-project execution lock (unchanged)
├── runs/<runId>.json          # full RunRecord — schema unchanged
├── reports/<taskId>/<runId>.md  # per-run Markdown report (0.10.0)
├── sessions/<taskId>/<runId>.jsonl
└── config.json                # notification channels (unchanged)
```

The `RunRecord` schema is deliberately unchanged: a run record lives inside
the project that produced it, so the project is implicit by location and
needs no `projectDir` field.

### Global store: `~/.agents/cron/`

```
~/.agents/cron/
├── tasks.json       # version 2 registry (this ADR)
├── registry.lock    # short-lived write lock, never held during execution
└── cron.log         # redirect target for the single crontab line
```

`AGENTS_CRON_HOME` overrides the global directory (test injection and
non-default homes); it never affects project stores.

## Out of scope (explicitly not doing)

- **Dual/hybrid stores** — rejected in favor of the single registry + view.
- **Multi-machine sync** — single-machine assumption. No dotfiles-sync design:
  synced registries would collide on paths and IDs. Revisit only with a real
  second machine.
- **`move` command for relocated projects** — hand-editing the registry JSON
  is safe (one field); the `⚠ missing directory` marker surfaces the problem.
  Add tooling only after this hurts twice.
- **Global run history** — full run records stay in projects; the registry
  carries only counters and `lastStatus`. From another directory you see the
  summary, not the transcripts — by design.
- **Notification payloads as full reports** (deferred follow-up to the
  per-run report files): email/webhook bodies stay one-line summaries for
  now; upgrading them to carry the report Markdown is a later, additive
  change.
- **Sharded registry** (`projects/<hash>/tasks.json`) — single file + registry
  lock is enough at cron granularity; a corrupt file is backed up as
  `.corrupt.<ts>` and runs survive in their projects.

## Consequences

- `paths.ts` splits into global paths (registry, registry lock) and project
  paths (runs, sessions, config, run.lock); the v0.7 `.pi/scheduler` migration
  stays as-is.
- `runDue` gains a global mode (no project → all projects, grouped); the
  per-project mode remains as the legacy crontab compatibility path.
- `addTask`/`listTasks`/`removeTask`/… lose their `projectDir` parameter in
  favor of registry operations plus a view; task services get a registry
  service.
- ID prefix matching operates over the whole registry; ambiguity errors
  already exist and get likelier with scale — acceptable.
- README's storage-layout and crontab sections changed with the 0.9.0
  implementation; this ADR records why the registry looks the way it does.
