import { createHmac } from "node:crypto";
import { bodyOf, subjectOf } from "./format.ts";
import type { FeishuChannel, Notifier, RunNotification } from "./types.ts";

/** Delivery budget per channel; a hung endpoint must not stall a cron pass. */
const TIMEOUT_MS = 10_000;

/**
 * Feishu's custom-bot signature scheme (签名校验): sign is base64 over
 * HMAC-SHA256 keyed by `"<timestamp>\n<secret>"` with an empty message, where
 * the timestamp is current-epoch-seconds and travels beside the signature in
 * the body.
 */
export function feishuSign(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

/**
 * The first-class Feishu channel: posts the run to a custom bot webhook as a
 * text message. A bot secured with 签名校验 signs every request — point
 * `secretEnv` at the env var holding the secret (the secret lives in the
 * environment, never the config file, like the SMTP password). Keyword-
 * secured (自定义关键词) and open bots need no signature: leave `secretEnv`
 * out and the body goes unsigned. Feishu answers HTTP 200 even when it
 * refuses a message, so the response's `code` carries the truth.
 */
export function feishuNotifier(channel: FeishuChannel, env: NodeJS.ProcessEnv = process.env): Notifier {
  return {
    id: channel.id,
    async send(n: RunNotification): Promise<void> {
      const secretEnv = channel.secretEnv ?? "AGENTS_CRON_FEISHU_SECRET";
      const secret = env[secretEnv];
      if (channel.secretEnv && !secret) {
        throw new Error(`feishu channel "${channel.id}" signs its requests, but ${secretEnv} is not set`);
      }

      const body: Record<string, unknown> = {
        msg_type: "text",
        content: { text: `${subjectOf(n)}\n\n${bodyOf(n)}` },
      };
      if (secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        body.timestamp = timestamp;
        body.sign = feishuSign(timestamp, secret);
      }

      const res = await fetch(channel.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`feishu answered HTTP ${res.status}`);
      const answer = (await res.json().catch(() => undefined)) as { code?: number; msg?: string } | undefined;
      // Only an explicit non-zero code is a rejection; endpoints that answer
      // nothing (or Feishu-compatible servers without a body) stay OK.
      if (typeof answer?.code === "number" && answer.code !== 0) {
        throw new Error(`feishu bot rejected the message: ${answer.code} ${answer.msg ?? ""}`.trim());
      }
    },
  };
}
