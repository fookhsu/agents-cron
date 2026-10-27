import { spawn } from "node:child_process";
import { subjectOf } from "./format.ts";
import type { Notifier, RunNotification, SystemChannel } from "./types.ts";

/** Same delivery budget as a webhook: a hung helper must not stall a cron pass. */
const TIMEOUT_MS = 10_000;

/** Notifications carry model output; never let it grow past a banner's size. */
const MAX_DETAIL = 500;

/** Injectable process runner so tests never pop real notifications. */
export type CommandRunner = (command: string, args: string[]) => Promise<{ status: number | null; stderr: string }>;

const spawnRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });

/**
 * Announces a finished run on the desktop: macOS Notification Center via
 * osascript, Linux via notify-send. The summary is model output, so it is
 * length-capped and AppleScript-escaped before it ever reaches a script.
 */
export function systemNotifier(
  channel: SystemChannel,
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = spawnRunner,
): Notifier {
  return {
    id: channel.id,
    async send(n: RunNotification): Promise<void> {
      const title = `agents-cron ${subjectOf(n)}`;
      const detail = cap(n.summary ?? n.error ?? "run finished");
      if (platform === "darwin") {
        const result = await run("osascript", [
          "-e",
          [
            `display notification "${escape(detail)}"`,
            `with title "${escape(title)}"`,
            `subtitle "${escape(n.project)}"`,
            ...(channel.sound ? [`sound name "${escape(channel.sound)}"`] : []),
          ].join(" "),
        ]);
        requireSuccess("osascript", result);
        return;
      }
      if (platform === "linux") {
        const result = await run("notify-send", [title, detail]);
        requireSuccess("notify-send", result);
        return;
      }
      throw new Error(`system channel "${channel.id}" supports macOS and Linux, not ${platform}`);
    },
  };
}

/** A helper that exited non-zero (or was killed) failed — surface its exit status and stderr. */
function requireSuccess(command: string, result: { status: number | null; stderr: string }): void {
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.stderr.trim()}`);
}

/** AppleScript string literal: only backslash and double quote are special. */
function escape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function cap(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}
