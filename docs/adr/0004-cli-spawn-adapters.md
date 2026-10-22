# ADR 0004: CLI-spawn agent adapters — Claude Code and Codex

- Status: Accepted
- Date: 2026-10-16
- Merges the former ADR 0005, which applied this ADR's pattern to a second CLI.

## Context

ADR 0002 made the scheduler agent-agnostic, but only the Pi adapter existed, so a scheduled task always required a `pi` executable (or SDK). Users of other agents — starting with Claude Code, which ships a mature headless mode — could manage the store but not execute tasks. Codex ships a headless mode (`codex exec`) with a JSONL event stream and a sandbox model, so the same spawn-the-CLI pattern applies. Copy-pasting the adapter plumbing would have duplicated prompt formatting, process capture, and cron-safe binary resolution in every adapter.

## Decision

Add one adapter per agent, each spawning the user's own headless CLI in the task's `cwd`, so credentials, model access, and trust rules stay between the user and the agent runtime:

- Claude Code at `src/agents/claude/adapter.ts`, Codex at `src/agents/codex/adapter.ts`, registered behind `pi` so Pi stays the default agent.
- Prompt formatting, output capture, binary resolution, and summary trimming live in `src/agents/run-utils.ts`, shared with the Pi adapter.
- Each adapter writes a JSON session record at `.agents/cron/sessions/<taskId>/<runId>.json` (exit code, final message, runtime specifics). A failed run still gets its record before the error propagates.
- Each binary resolves via its env override (`PI_SCHEDULER_CLAUDE_BIN` / `PI_SCHEDULER_CODEX_BIN`), then `$PATH`, mirroring `PI_SCHEDULER_PI_BIN`.

Runtime-specific semantics, documented in the README where tasks are defined:

- **Claude Code**: spawns `claude --print --output-format json`. The task's `tools` map to `--allowedTools`, because a headless run cannot approve permission prompts: an unallowed tool is denied, not asked. `thinking` has no equivalent and is ignored.
- **Codex**: spawns `codex exec --json --skip-git-repo-check --output-last-message <tmp>`; the final message falls back to the last `agent_message` event in the JSONL stream. The task's `tools` map to sandbox level, not a per-tool allowlist: no `tools` runs `--sandbox read-only`; any `tools` runs `workspace-write`. `codex exec` fixes its approval policy at "never", so the sandbox decides what a headless run may touch and it can never block on an approval. `thinking` has no equivalent and is ignored.

## Consequences

`--agent claude` runs scheduled work through Claude Code with no Pi install; `--agent codex` needs neither. Adapter-local behavior stays explicit: session-record format and permission posture are documented in the README rather than hidden behind the shared contract. Shared utilities keep future adapters small, at the cost of one more module every adapter imports. A third adapter costs one file plus one registration line, which is the extensibility ADR 0002 paid for.

## Alternatives considered

- **Wait for per-agent SDKs**: loses headless parity and keeps the package Pi-only indefinitely.
- **A generic "shell out to any CLI" adapter**: reintroduces arbitrary shell execution, which the plugin forbids (ADR 0002), and cannot record a session or structured summary.
- **Per-tool sandbox config for Codex**: Codex's CLI has no such flag; inventing one would desync from the runtime's own semantics.
- **Run everything `workspace-write`**: unsafe as a default for headless runs that nobody watches.
- **An MCP or SDK integration for Codex**: would move credentials into the scheduler and break the bare-`node`-under-cron constraint (ADR 0002).
