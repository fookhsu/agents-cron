# ADR 0004: Claude Code adapter

- Status: Accepted
- Date: 2026-10-16

## Context

ADR 0003 made the scheduler agent-agnostic, but only the Pi adapter existed, so a scheduled task always required a `pi` executable. Users of other agents — starting with Claude Code, which ships a mature headless mode — could manage the store but not execute tasks. Sharing the adapter plumbing across agents by copy-paste would have duplicated prompt formatting, process capture, and cron-safe binary resolution in every adapter.

## Decision

Add a Claude Code adapter at `src/agents/claude/adapter.ts`, registered behind `pi` so Pi stays the default agent:

- A Task Run spawns `claude --print --output-format json` in the task's `cwd` — the user's own CLI, so credentials, model access, and permissions stay between the user and Claude Code.
- Claude Code owns the real session transcript. The adapter writes the JSON result (final message, `session_id`, usage) as the run's session record at `.pi/scheduler/sessions/<taskId>/<runId>.json`; a result with `is_error` fails the run but is still recorded.
- The task's `tools` map to `--allowedTools`, because a headless run cannot approve permission prompts: an unallowed tool is denied, not asked. `thinking` has no Claude Code equivalent and is ignored.
- The `claude` binary resolves via `PI_SCHEDULER_CLAUDE_BIN`, then `$PATH`, mirroring `PI_SCHEDULER_PI_BIN`.
- Prompt formatting, output capture, binary resolution, and summary trimming move to `src/agents/run-utils.ts`, shared with the Pi adapter.

## Consequences

`--agent claude` (or `agent: "claude"` on a task) runs scheduled work through Claude Code with no Pi install. Adapter-local behavior stays explicit: session-record format and permission posture are documented in the README rather than hidden behind the shared contract. Shared utilities keep future adapters small, at the cost of one more module both adapters import.

## Alternatives considered

- **Wait for per-agent SDKs**: loses headless parity and keeps the package Pi-only indefinitely.
- **A generic "shell out to any CLI" adapter**: reintroduces arbitrary shell execution, which the plugin forbids (ADR 0002), and cannot record a session or structured summary.
