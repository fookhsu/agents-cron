# ADR 0008: Opt-in Task Session placement in Pi's session store

Date: 2026-10-22
Status: Accepted

## Context

Issue #8: Task Session transcripts live in the scheduler-private layout
(`.agents/cron/sessions/<taskId>/<runId>.jsonl`), so scheduled runs never show
up in `pi --continue` pickers or pi-web's project session lists — those tools
scan only Pi's default store (`<agentDir>/sessions/--<encoded-cwd>--/`, first
level, `.jsonl` files, per `getDefaultSessionDirPath` and `listAll` in
pi-coding-agent). Users can find runs via `/schedule open` and the dashboard,
but the sessions are invisible to every standard Pi tool.

Moving placement naively would change behavior for existing installs, and
chasing a specific reader (pi-web today, another tool tomorrow) would make the
write path unstable.

## Decision

1. **Placement follows the producer's canonical contract, not any reader's.**
   The transcript is a Pi session produced by spawning `pi`; when opted in, it
   goes exactly where Pi itself records sessions for that cwd. One target per
   agent, owned by the agent's own contract — every Pi-conformant consumer
   (pi pickers, pi-web and its forks, future tools) reads that one place.

2. **Opt-in via `AGENTS_CRON_PI_STORE=1`, default off.** Unset, every existing
   install keeps the private layout byte-for-byte. The flag is new, so it has
   no `PI_SCHEDULER_*` legacy spelling.

3. **`src/agents/pi/pi-store.ts` mirrors the store contract without importing
   the SDK** (a Task Run must work from a bare `node` process under cron):
   root from `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) or the flat
   `PI_CODING_AGENT_SESSION_DIR` override; directory name
   `--${cwd with leading separator stripped and / \ : as "-"}--`, with the cwd
   canonicalized (`realpath`) to match what `process.cwd()` reports to Pi.
   Unit tests pin the encoding against hand-computed literals from Pi's
   implementation, so drift on either side turns red.

4. **Filename `<taskId>-<runId>.jsonl`, a first-level file.** Pi's scanners do
   not recurse, so the per-task directory level cannot survive in the store;
   the `taskId-` prefix preserves attribution. `runId` is globally unique, so
   isolation is unchanged — still one fresh session per run.

5. **Reads are self-describing: the run record is the source of truth.**
   Adapters already report `sessionFile` and the runner persists it. The
   dashboard's session endpoint reads the record's path first and falls back
   to the private-layout convention for records that predate the field; no
   environment variable is needed on any read path, and mixed layouts
   (pre/post opt-in, migrated or not) all resolve correctly.

## Consequences

- Relocations flow through Pi's official env vars, so a user who moves the
  store keeps Pi, pi-web, and the scheduler in agreement with zero extra
  configuration.
- A future Pi change to the store encoding would need a mirror update; the
  pinned tests surface it, and default-off placement contains the blast
  radius.
- Legacy transcripts are not migrated implicitly: `agents-cron migrate-sessions
  [--dry-run]` does it on demand under the run lock, relocating each pi
  transcript by the cwd recorded in its own session header (task `cwd`, then
  project root, as fallbacks), rewriting run records, refusing to overwrite,
  and leaving other agents' transcripts untouched. Idempotent by design.
- `settings.json`-level session-dir overrides in Pi are not mirrored (same
  limitation as any external tool); the documented env vars are the supported
  relocation mechanism.
