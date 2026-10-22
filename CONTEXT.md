# Pi Scheduler Context

This project executes scheduled prompt tasks for Pi. Triggering is owned by an external scheduler, so the language separates planned time from execution: the plugin decides which tasks are due and runs them, and never owns timing.

## Scheduling

**Schedule Task**:
A stored prompt plus a time rule defining work to be performed at a planned time or cadence.
_Avoid_: Job, cron job, reminder, durable task, session task.

**Due Task**:
A schedule task whose planned time has arrived at the moment the task runner is invoked.
_Avoid_: Pending task, queued job.

**Missed Task**:
A due task whose grace window ended before any task run claimed it.
_Avoid_: Expired task.

**Trigger**:
The cause of a task run: `scheduled` when the task's planned time arrived, `manual` when a user requested it directly.
_Avoid_: Event, cause, cron.

## Registry

**Task Registry**:
The single machine-wide store (`~/.agents/cron/tasks.json`) holding every task definition and its authoritative scheduling state.
_Avoid_: Global store, task list, index.

**Project Directory**:
The absolute path a task is bound to (`projectDir`). It owns that task's run artifacts, run lock, and notification config.
_Avoid_: Workspace, repo, root.

**Registry Lock**:
The short-lived machine-wide lock that serializes read-modify-write access to the task registry. Never held while executing a task.
_Avoid_: Global lock, mutex.

**Registry State**:
The per-task scheduling facts kept in the registry: `nextRunAt`, `enabled`, `lastRunAt`, `lastStatus`, and the run counters.
_Avoid_: Task status, metadata, cache.

**Run Artifacts**:
The run records, Markdown run reports, and session transcripts a project stores locally. Append-only; never carry scheduling state.
_Avoid_: Results, output, logs.

**Run Report**:
The Markdown document every terminal run leaves next to its run record. Metadata plus the full summary; links the session instead of inlining it.
_Avoid_: Result file, output file, log.

**Project View**:
The registry filtered and ordered for one working directory: its own tasks first, then every other project's.
_Avoid_: Local store, local tasks (implies a second store).

## Execution

**Task Runner**:
The component that executes due schedule tasks, creating one task session per task run. It is invoked by an external scheduler and never schedules itself.
_Avoid_: Scheduler, daemon, worker.

**Task Run**:
One execution attempt of a schedule task.
_Avoid_: Task, job run, execution.

**Run Claim**:
The exclusive marker that one task run has been taken up by a task runner. A claim left behind by a crashed run is stale and may be reclaimed by a later invocation.
_Avoid_: Lock, lease.

**Run Lock**:
The project-wide exclusive lock that allows at most one task runner to execute at a time.
_Avoid_: Claim, mutex.

**Task Session**:
An isolated agent session belonging to one task run and separate from the user's interactive session.
_Avoid_: Background session, shared session.

## Agents

**Agent Adapter**:
The component that drives one task run in a concrete agent runtime, owning everything runtime-specific: session creation, model resolution, credentials.
_Avoid_: Provider, backend, driver, integration.

**Agent Registry**:
The lookup from an agent id to its adapter. Adapters load lazily, so an unused agent runtime is never imported.
_Avoid_: Plugin manager, factory.

## Sessions

**Pi Session**:
A conversation and its recorded context owned by one Pi runtime.
_Avoid_: Window, task, run.

**User Pi Session**:
The interactive Pi session in which a user creates and manages schedule tasks.
_Avoid_: Main session, global session.
