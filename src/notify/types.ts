/**
 * Run notifications: the second adapter family. Agent adapters own "how a run
 * executes"; notifiers own "how a finished run is announced". The Task Runner
 * treats them uniformly — after a run record reaches a terminal state, the
 * configured channels are offered a notification, best effort.
 */

/** Identifies one configured channel — the `id` of a `channels[]` entry; tasks route by it. */
export type ChannelId = string;

/** Posts the run to an HTTP endpoint (Slack, Lark, Discord, n8n, …). */
export type WebhookChannel = {
  id: string;
  type: "webhook";
  url: string;
  /** Extra request headers, e.g. `{"Authorization": "Bearer …"}`. */
  headers?: Record<string, string>;
  /** json (default) posts the raw notification; text posts plain text; feishu posts the Feishu bot body. */
  format?: "json" | "text" | "feishu";
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

/** Posts the run to a Feishu custom bot (自定义机器人), signing when configured. */
export type FeishuChannel = {
  id: string;
  type: "feishu";
  /** The bot webhook URL, https://open.feishu.cn/open-apis/bot/v2/hook/…. */
  url: string;
  /**
   * Env var holding the 签名校验 (signature) secret; defaults to
   * AGENTS_CRON_FEISHU_SECRET. Absent → the body goes unsigned, which suits
   * keyword-secured (自定义关键词) and open bots. Set but unset in the env →
   * the send fails loudly rather than silently skipping the signature.
   */
  secretEnv?: string;
};

/** Sends the run to a Telegram chat through a bot. */
export type TelegramChannel = {
  id: string;
  type: "telegram";
  /** Numeric chat id, or an @name for a public channel. */
  chatId: string;
  /** Env var holding the bot token; defaults to AGENTS_CRON_TELEGRAM_TOKEN. */
  tokenEnv?: string;
  /** API base for a self-hosted Bot API server; defaults to https://api.telegram.org. */
  apiBase?: string;
};

/** Shows the run as a desktop notification (macOS Notification Center, Linux notify-send). */
export type SystemChannel = {
  id: string;
  type: "system";
  /** macOS sound name (Glass, Ping, …); ignored on Linux. */
  sound?: string;
};

export type NotificationChannel = WebhookChannel | EmailChannel | SystemChannel | FeishuChannel | TelegramChannel;

/** Which runs produce a notification. */
export type NotifyLevel = "always" | "error" | "never";

export type NotificationsConfig = {
  /** Project-wide default; a task's `notify` field overrides it. */
  on: NotifyLevel;
  /** Project-wide default routing; a task's `notifyTo` field overrides it, and absent routing means every channel. */
  defaultTo?: ChannelId[];
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
