# ADR 0002: Background Task Runner and the agent adapter layer

- Status: Accepted
- Dates: 2026-09-10 (runner), 2026-09-12 (adapter layer)
- Merges the former ADR 0003, which restructured this ADR's original executor two days after it was written.

## Context

Pi is an interactive runtime and does not run work on its own after it exits. Scheduled tasks must run unattended, be triggered by system cron, and keep task-granularity session records separate from the user's Pi window instead of mixing run history into one session tree.

The first implementation (ADR 0002 as originally written) put the Pi SDK directly inside the Task Runner. But the scheduler's own job — scheduling, storage, locking, run records — has nothing to do with which agent executes the prompt, and a user may want scheduled work to run in more than one agent runtime. Keeping the SDK inline also made Pi a hard import for the cron CLI, so the package could not run without it.

## Decision

Execution is a background Task Runner behind an agent adapter layer:

**Runner boundaries**

- Pi is only a management surface; the `agents-cron run-due` CLI is the single execution entry point, invoked by system cron.
- Each Task Run creates a fully isolated Task Session in the target agent; consecutive runs of the same task never share context.
- Run records and session artifacts are persisted under the project store; a `run.lock` and per-run records make `run-due` idempotent. (The store path was `.pi/scheduler/` at first, moved to `.agents/cron/` in v0.7, and split registry/artifacts by ADR 0007 — the isolation and locking semantics never changed.)
- The plugin never manages the system crontab; it never executes arbitrary shell commands; run results are never injected into the user's Pi session.

**Adapter layer** (former ADR 0003)

- An `AgentAdapter` (`src/agents/types.ts`) drives one Task Run in a concrete runtime — session creation, model resolution, credentials. Its contract is `run(request): Promise<AgentRunResult>`.
- An `AgentRegistry` (`src/agents/registry.ts`) resolves an agent id to its adapter. Adapters register lazily, so an unused agent SDK is never imported, and the first registered adapter is the default.
- The Task Runner depends on the registry, never on an SDK. A task may name its `agent`; otherwise the runner uses the invocation's default (`--agent`).
- All Pi-specific code lives under `src/agents/pi/`: the SDK adapter plus the extension, tools, and slash commands.
- A `RunRecord` records the `agent` that drove the run.

## Consequences

Execution survives Pi exit and is isolated per run, at the cost of requiring the user to install a cron entry. Scheduled prompts and session files may be sensitive, so they live gitignored with `0600` permissions.

The core is agent-agnostic and testable with a fake adapter. Adding an agent is a folder plus one `registerAgent` line, with no change to the runner, stores, CLI, or Pi surface. Pi is an optional peer dependency rather than a requirement of the CLI.

## Alternatives considered

- **A persistent daemon**: better latency but adds lifecycle, PID, and upgrade management; deferred as an optional loop wrapper around `run-due`.
- **Per-task crontab entries**: high operational and portability cost, conflicts with the KISS principle; ruled out of scope.
- **Keep the Pi-only executor and fork per agent**: duplicates the runner, storage, and CLI for each agent.
- **A generic adapter that shells out to an arbitrary command line**: loses the session file and structured summary, and reintroduces arbitrary shell execution, which the plugin forbids.
