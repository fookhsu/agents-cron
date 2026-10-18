/**
 * Set while an agent process is hosting a Task Session, so the scheduler
 * extension stays inert and cannot schedule more work.
 */
export const TASK_SESSION_ENV = "AGENT_CRON_TASK_SESSION";

/**
 * The pre-rename spelling of {@link TASK_SESSION_ENV}. Still honored when read
 * and still set when spawning, so a Task Session driven by a new adapter stays
 * inert even when the project loads an older extension, and vice versa.
 */
export const LEGACY_TASK_SESSION_ENV = "PI_SCHEDULER_TASK_SESSION";
