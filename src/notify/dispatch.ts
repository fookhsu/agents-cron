import { basename } from "node:path";
import type { RunRecord, ScheduleTask } from "../types.ts";
import { emailNotifier } from "./email.ts";
import { systemNotifier } from "./system.ts";
import { webhookNotifier } from "./webhook.ts";
import type { ChannelId, Notifier, NotificationChannel, NotificationsConfig, NotifyLevel, RunNotification } from "./types.ts";

/** Whether a run with this status warrants a notification at this level. */
export function shouldNotify(level: NotifyLevel, status: RunRecord["status"]): boolean {
  if (level === "never") return false;
  if (level === "always") return status === "success" || status === "error" || status === "missed";
  return status === "error" || status === "missed";
}

/** Resolves configured channels into notifiers, skipping unknown types. */
export function notifiersFor(config: NotificationsConfig): Notifier[] {
  const notifiers: Notifier[] = [];
  for (const channel of config.channels) {
    const notifier = notifierFor(channel);
    if (notifier) notifiers.push(notifier);
    else process.stderr.write(`[agents-cron] unknown notification channel type "${(channel as NotificationChannel).type}"; skipped\n`);
  }
  return notifiers;
}

/**
 * Resolves which configured channels a list of channel ids addresses:
 * routing filters the configured set by channel id; absent or empty means
 * every channel. Unknown ids warn on stderr and are skipped — a typo must
 * not silence the rest.
 */
export function notifiersForTask(config: NotificationsConfig, ids?: ChannelId[]): Notifier[] {
  const all = notifiersFor(config);
  if (!ids?.length) return all;
  const byId = new Map(all.map((notifier) => [notifier.id, notifier]));
  const selected: Notifier[] = [];
  for (const id of ids) {
    const notifier = byId.get(id);
    if (notifier) selected.push(notifier);
    else process.stderr.write(`[agents-cron] unknown notification channel "${id}"; skipped\n`);
  }
  return selected;
}

function notifierFor(channel: NotificationChannel): Notifier | undefined {
  if (channel.type === "webhook") return webhookNotifier(channel);
  if (channel.type === "email") return emailNotifier(channel);
  if (channel.type === "system") return systemNotifier(channel);
  return undefined;
}

/**
 * Offers one finished run to the channels a task addresses, best effort: a
 * level check first, then the selected channels in parallel, and every
 * failure is reported on stderr instead of thrown — a broken webhook must
 * never break the run itself. Routing resolves like the level does: the task's
 * own `notifyTo` first, then the config's `defaultTo`, then every channel.
 */
export async function dispatchNotifications(
  config: NotificationsConfig,
  task: ScheduleTask,
  run: RunRecord,
  projectDir: string,
): Promise<void> {
  const level = task.notify ?? config.on;
  if (run.status === "running") return; // only terminal runs are announced
  if (!shouldNotify(level, run.status)) return;
  if (config.channels.length === 0) {
    // Unconfigured is a valid state, not an error: remind where the announcement
    // would have gone (cron log / terminal stderr) and move on.
    process.stderr.write(`[agents-cron] no notification channels configured; not announcing ${run.status} run of task ${task.id} (see agents-cron setup-notify)\n`);
    return;
  }

  const notifiers = notifiersForTask(config, task.notifyTo ?? config.defaultTo);
  if (notifiers.length === 0) return;

  const notification: RunNotification = {
    project: basename(projectDir),
    taskId: task.id,
    ...(task.name ? { taskName: task.name } : {}),
    runId: run.runId,
    trigger: run.trigger,
    status: run.status,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.agent ? { agent: run.agent } : {}),
    ...(run.summary ? { summary: run.summary } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  };

  const settled = await Promise.allSettled(notifiers.map((n) => n.send(notification)));
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      process.stderr.write(`[agents-cron] notify ${notifiers[i].id} failed: ${reason}\n`);
    }
  });
}
