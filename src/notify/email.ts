import { bodyOf, subjectOf } from "./format.ts";
import type { EmailChannel, Notifier, RunNotification } from "./types.ts";

/** What nodemailer's transport needs; injectable so tests never touch SMTP. */
export type MailTransport = {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
};

export type TransportFactory = (channel: EmailChannel, password?: string) => Promise<MailTransport>;

/**
 * Builds the real transport by lazily importing nodemailer, which is an
 * optional dependency: only projects that configure an email channel pay for
 * it, and everyone else keeps the zero-SMTP footprint of the core package.
 */
const nodemailerTransport: TransportFactory = async (channel, password) => {
  let nodemailer: typeof import("nodemailer");
  try {
    nodemailer = await import("nodemailer");
  } catch {
    throw new Error(
      `email channel "${channel.id}" needs the optional nodemailer package: run "npm install nodemailer" (or reinstall agents-cron)`,
    );
  }
  return nodemailer.createTransport({
    host: channel.host,
    port: channel.port ?? 465,
    secure: channel.secure ?? (channel.port ?? 465) === 465,
    ...(channel.user ? { auth: { user: channel.user, pass: password ?? "" } } : {}),
  }) as unknown as MailTransport;
};

export function emailNotifier(
  channel: EmailChannel,
  env: NodeJS.ProcessEnv = process.env,
  createTransport: TransportFactory = nodemailerTransport,
): Notifier {
  return {
    id: channel.id,
    async send(n: RunNotification): Promise<void> {
      const password = env[channel.passwordEnv ?? "AGENTS_CRON_SMTP_PASSWORD"];
      if (channel.user && !password) {
        throw new Error(
          `email channel "${channel.id}" authenticates as ${channel.user}, but ${channel.passwordEnv ?? "AGENTS_CRON_SMTP_PASSWORD"} is not set`,
        );
      }
      const transport = await createTransport(channel, password);
      await transport.sendMail({
        from: channel.from,
        to: channel.to,
        subject: `${channel.subjectPrefix ?? "[agents-cron] "}${subjectOf(n)}`,
        text: bodyOf(n),
      });
    },
  };
}
