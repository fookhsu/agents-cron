# ADR 0005: Codex adapter

- Status: Accepted
- Date: 2026-10-16

## Context

After ADR 0004, tasks can run on Pi or Claude Code, and both adapters share `src/agents/run-utils.ts`. Codex users can manage the store from a Codex session (the SKILL.md escape hatch), but a due task cannot execute on Codex — there is no `codex` adapter. Codex ships a headless mode (`codex exec`) with a JSONL event stream and a sandbox model, so the same spawn-the-CLI pattern applies.

## Decision

Add a Codex adapter at `src/agents/codex/adapter.ts`, registered behind `pi` and `claude` so Pi stays the default agent:

- A Task Run spawns `codex exec --json --skip-git-repo-check --output-last-message <tmp>` in the task's `cwd` — the user's own CLI, so credentials, model access, and trust rules stay between the user and Codex.
- The final message is read from `--output-last-message`, falling back to the last `agent_message` event in the JSONL stream. Codex owns its transcript (`~/.codex/sessions/`); the adapter writes a JSON record — exit code, final message, event tail — at `.pi/scheduler/sessions/<taskId>/<runId>.json`. A failed run still gets its record before the error propagates, mirroring the Claude Code adapter.
- The task's `tools` map to sandbox level, not a per-tool allowlist: no `tools` runs `--sandbox read-only`; any `tools` runs `workspace-write`. Codex has no per-tool allowlist, and `codex exec` fixes its approval policy at "never", so the sandbox decides what a headless run may touch and it can never block on an approval. `thinking` has no Codex equivalent and is ignored.
- The `codex` binary resolves via `PI_SCHEDULER_CODEX_BIN`, then `$PATH`, mirroring the other adapters.

## Consequences

`--agent codex` runs scheduled work on Codex with no Pi or Claude Code install. The tools-to-sandbox mapping is coarser than Claude Code's allowlist; the README documents it so the difference is visible where tasks are defined. A third adapter costs one file plus one registration line, which is the extensibility ADR 0003 paid for.

## Alternatives considered

- **Per-tool sandbox config**: Codex's CLI has no such flag; inventing one would desync from the runtime's own semantics.
- **Run everything `workspace-write`**: unsafe as a default for headless runs that nobody watches.
- **An MCP or SDK integration**: would move credentials into the scheduler and break the bare-`node`-under-cron constraint (ADR 0002).
