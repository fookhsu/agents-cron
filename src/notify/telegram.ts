import { bodyOf, subjectOf } from "./format.ts";
import type { Notifier, RunNotification, TelegramChannel } from "./types.ts";

/** Delivery budget per channel; a hung endpoint must not stall a cron pass. */
const TIMEOUT_MS = 10_000;

const DEFAULT_API_BASE = "https://api.telegram.org";

/**
 * The Telegram channel: posts the run into one chat through a bot. The bot
 * token always comes from the environment, never the config file — `tokenEnv`
 * names the variable, AGENTS_CRON_TELEGRAM_TOKEN by default. `chatId` is the
 * numeric id of a user, group, or channel, or an @name for a public channel;
 * `apiBase` points at a self-hosted Bot API server when you run one.
 */
export function telegramNotifier(channel: TelegramChannel, env: NodeJS.ProcessEnv = process.env): Notifier {
  return {
    id: channel.id,
    async send(n: RunNotification): Promise<void> {
      const tokenEnv = channel.tokenEnv ?? "AGENTS_CRON_TELEGRAM_TOKEN";
      const token = env[tokenEnv];
      if (!token) {
        throw new Error(`telegram channel "${channel.id}" needs a bot token in $${tokenEnv}`);
      }

      const base = (channel.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
      const res = await fetch(`${base}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: channel.chatId,
          text: `${subjectOf(n)}\n\n${bodyOf(n)}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Telegram reports failures twice over — an HTTP error status and an
      // {ok: false, description} body — so surface whichever carries detail.
      const answer = (await res.json().catch(() => undefined)) as { ok?: boolean; description?: string } | undefined;
      if (!res.ok || answer?.ok === false) {
        const detail = answer?.description ? `: ${answer.description}` : "";
        throw new Error(`telegram answered HTTP ${res.status}${detail}`);
      }
    },
  };
}
