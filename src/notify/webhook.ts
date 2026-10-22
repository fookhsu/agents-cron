import { bodyOf, subjectOf } from "./format.ts";
import type { Notifier, RunNotification, WebhookChannel } from "./types.ts";

/** Delivery budget per channel; a hung endpoint must not stall a cron pass. */
const TIMEOUT_MS = 10_000;

export function webhookNotifier(channel: WebhookChannel): Notifier {
  return {
    id: channel.id,
    async send(n: RunNotification): Promise<void> {
      const body =
        channel.format === "feishu"
          ? JSON.stringify({ msg_type: "text", content: { text: `${subjectOf(n)}\n\n${bodyOf(n)}` } })
          : channel.format === "text"
            ? `${subjectOf(n)}\n\n${bodyOf(n)}`
            : JSON.stringify({ source: "agents-cron", ...n }, null, 2);
      const res = await fetch(channel.url, {
        method: "POST",
        headers: {
          "content-type": channel.format === "text" ? "text/plain; charset=utf-8" : "application/json",
          ...(channel.headers ?? {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
    },
  };
}
