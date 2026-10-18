/**
 * Run notifications: the second adapter family. Agent adapters own "how a run
 * executes"; notifiers own "how a finished run is announced". The Task Runner
 * treats them uniformly — after a run record reaches a terminal state, the
 * configured channels are offered a notification, best effort.
 */

/** Posts the run to an HTTP endpoint (Slack, Lark, Discord, n8n, …). */
export type WebhookChannel = {
  id: string;
  type: "webhook";
  url: string;
  /** Extra request headers, e.g. `{"Authorization": "Bearer …"}`. */
  headers?: Record<string, string>;
  /** `json` (default) posts a JSON document; `text` posts the human summary. */
  format?: "json" | "text";
};

/** Sends the run as an email over SMTP. */
export type EmailChannel = {
  id: string;
  type: "email";
  host: string;
  /** Defaults to 465. */
  port?: number;
  /** Defaults to true when the port is 465, false otherwise. */
  secure?: boolean;
  /** SMTP user; omit for an unauthenticated relay. */
  user?: string;
  /** Env var holding the SMTP password; defaults to AGENTS_CRON_SMTP_PASSWORD. */
  passwordEnv?: string;
  from: string;
  /** Comma-separated recipient list. */
  to: string;
  subjectPrefix?: string;
};

export type NotificationChannel = WebhookChannel | EmailChannel;

/** Which runs produce a notification. */
export type NotifyLevel = "always" | "error" | "never";

export type NotificationsConfig = {
  /** Project-wide default; a task's `notify` field overrides it. */
  on: NotifyLevel;
  channels: NotificationChannel[];
};

/** A finished run, shaped for delivery. */
export type RunNotification = {
  project: string;
  taskId: string;
  taskName?: string;
  runId: string;
  trigger: "scheduled" | "manual";
  status: "success" | "error" | "skipped" | "missed";
  exitCode?: number;
  agent?: string;
  summary?: string;
  error?: string;
  sessionFile?: string;
  startedAt: string;
  finishedAt?: string;
};

/** One delivery channel, resolved and ready to send. */
export type Notifier = {
  readonly id: string;
  send(notification: RunNotification): Promise<void>;
};
