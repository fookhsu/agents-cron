import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmailChannel, NotificationChannel, NotificationsConfig, NotifyLevel, WebhookChannel } from "./types.ts";

/** The default: cron only interrupts you when something actually broke. */
export const DEFAULT_NOTIFY_LEVEL: NotifyLevel = "error";

/**
 * Reads `.agents/cron/config.json`. The file is optional and user-authored:
 * missing means "no channels", and anything malformed degrades to defaults
 * with a warning on stderr — a bad config must never take down a cron pass.
 */
export async function loadNotifyConfig(storeDir: string): Promise<NotificationsConfig> {
  const file = join(storeDir, "config.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { on: DEFAULT_NOTIFY_LEVEL, channels: [] };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalize(parsed, file);
  } catch (err) {
    warn(file, `not valid JSON (${err instanceof Error ? err.message : String(err)}); notifications disabled`);
    return { on: DEFAULT_NOTIFY_LEVEL, channels: [] };
  }
}

function normalize(parsed: Record<string, unknown>, file: string): NotificationsConfig {
  const notifications = (parsed.notifications ?? {}) as Record<string, unknown>;
  const on = isNotifyLevel(notifications.on) ? notifications.on : DEFAULT_NOTIFY_LEVEL;
  if (notifications.on !== undefined && !isNotifyLevel(notifications.on)) {
    warn(file, `notifications.on "${String(notifications.on)}" is not one of always|error|never; using "${on}"`);
  }

  const channels: NotificationChannel[] = [];
  for (const entry of Array.isArray(notifications.channels) ? notifications.channels : []) {
    const channel = asChannel(entry);
    if (channel) channels.push(channel);
    else warn(file, `dropping invalid notification channel ${JSON.stringify(entry)}`);
  }
  return { on, channels };
}

function asChannel(entry: unknown): NotificationChannel | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const c = entry as Record<string, unknown>;
  if (typeof c.id !== "string" || !c.id.trim()) return undefined;

  if (c.type === "webhook") {
    if (typeof c.url !== "string" || !/^https?:\/\//.test(c.url)) return undefined;
    const headers =
      c.headers && typeof c.headers === "object" && Object.values(c.headers).every((v) => typeof v === "string")
        ? (c.headers as Record<string, string>)
        : undefined;
    const format = c.format === "text" || c.format === "feishu" ? c.format : "json";
    return { id: c.id, type: "webhook", url: c.url, ...(headers ? { headers } : {}), ...(format === "text" ? { format } : {}) } satisfies WebhookChannel;
  }

  if (c.type === "email") {
    if (typeof c.host !== "string" || !c.host) return undefined;
    if (typeof c.from !== "string" || !c.from) return undefined;
    if (typeof c.to !== "string" || !c.to) return undefined;
    const port = typeof c.port === "number" ? c.port : 465;
    const channel: EmailChannel = {
      id: c.id,
      type: "email",
      host: c.host,
      port,
      from: c.from,
      to: c.to,
      ...(typeof c.secure === "boolean" ? { secure: c.secure } : { secure: port === 465 }),
      ...(typeof c.user === "string" && c.user ? { user: c.user } : {}),
      ...(typeof c.passwordEnv === "string" && c.passwordEnv ? { passwordEnv: c.passwordEnv } : {}),
      ...(typeof c.subjectPrefix === "string" && c.subjectPrefix ? { subjectPrefix: c.subjectPrefix } : {}),
    };
    return channel;
  }

  return undefined;
}

function isNotifyLevel(value: unknown): value is NotifyLevel {
  return value === "always" || value === "error" || value === "never";
}

function warn(file: string, message: string): void {
  process.stderr.write(`[agents-cron] ${file}: ${message}\n`);
}
