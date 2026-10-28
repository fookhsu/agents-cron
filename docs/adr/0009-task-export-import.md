# ADR 0009: Task export and import — definitions travel, state stays home

Date: 2026-10-28
Status: Accepted

## Context

Task definitions live in one machine-wide registry, bound to absolute
`projectDir` paths, with run artifacts in each project. That binding is right
for execution but wrong for portability: there is no supported way to carry
tasks to another machine, hand a task set to a teammate, or back the registry
up before something destroys it (`backupCorruptFile` already moves a corrupt
registry aside — correctly — leaving the user with nothing to restore from).

The naive answer — copy `tasks.json` — would smuggle registry state (`nextRunAt`,
`lastStatus`, counters), machine-local ids, and absolute paths across machines,
then run imported prompts with the importer's credentials on arrival.

## Decision

### A Task Export carries definitions only (Q1)

The export format is a versioned JSON file (`{version, exportedAt, tasks}`).
Each entry carries the definition — `name`, `prompt`, `schedule`, `agent`,
`model`, `thinking`, `cwd`, `tools`, `notify`, `notifyTo` — and nothing else.
`id`, `projectDir`, and every registry-state field stay home. Parsing is strict
in the registry's spirit: a bad version or a malformed entry fails the whole
file; schedules are validated as deeply as `add` validates them (a five-field
cron gains its second field, a `once` timestamp is canonicalised).

### Imports are new tasks, disabled by default (Q2)

Importing rebinds every entry to the importing project's directory, assigns a
fresh id, and computes `nextRunAt` from now — the same birth an `add` gives.
`enabled` deliberately does **not** travel: an imported prompt will execute
under the importer's agent and credentials, so every imported task starts
disabled and is reviewed before `/schedule enable`. This deviates from
CONTEXT.md's classification of `enabled` as registry state on purpose — user
intent about *whether* a task should run is exactly what must not be trusted
blindly across a machine boundary.

### Duplicate key: name + prompt + schedule (Q3)

An entry is a duplicate of an existing task of the target project only when
name, prompt, and schedule all match (absent names compare equal); duplicates
are skipped with a report line, everything else is created. Re-importing the
same file adds nothing. There is no `--replace` in v1: matching "the same task
that evolved" needs a stable key (a name is not one yet), and a desired-state
`sync` command is a better home for that semantics if it is ever wanted.

### Whole-machine backup without path restore (Q4)

`export --all` spans every project in the registry, but the file still carries
no `projectDir`: importing binds everything to the current project. Restore on
a new machine is therefore "import into one directory, then re-create the
project split by re-adding from there" — deliberately simpler than path
rewriting, which would need per-entry remapping UI and would still guess wrong
across machines with different layouts.

## Consequences

- `src/task-export.ts` owns the format (build, strict parse); `task-service.ts`
  owns `exportTasks`/`importTasks` over the registry; CLI and `/schedule`
  commands are thin surfaces (`export [--out] [--all] [ids…]`, `import <file>
  [--dry-run]` in the CLI; `/schedule export [file] [--all]`, `/schedule
  import <file>` in Pi).
- Import warnings (unknown notification channels, past `once` schedules) are
  collected into a report instead of stderr, so both surfaces show them the
  same way.
- One `updateRegistry` write covers an import batch: all created or none; a
  dry-run computes the identical report without writing.
- Run artifacts never travel — an imported task starts with no history; its
  counters and `lastStatus` begin on first run.
- The format's `version` is the upgrade path: accepting richer definitions
  (say, multi-prompt tasks) means version 2 and a migration note here.
