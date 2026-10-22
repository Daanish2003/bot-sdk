import { z } from "zod";

import type { EmailProvider, InboundMail, OutboundMail } from "../server/email";

const verdict = z.enum(["pass", "fail", "none"]);

/** A mail as the fake takes it: `from` and `to` are needed, every other field has a default. */
const fakeMailSchema = z.object({
  from: z.string(),
  to: z.array(z.string()),
  messageId: z.string().default(""),
  subject: z.string().default(""),
  text: z.string().default(""),
  headers: z.record(z.string(), z.string()).default({}),
  attachments: z.array(z.string()).default([]),
  authentication: z
    .object({ spf: verdict, dkim: verdict, dmarc: verdict })
    .default({ spf: "none", dkim: "none", dmarc: "none" }),
}) satisfies z.ZodType<InboundMail, unknown>;

/**
 * A fake email provider (spec #761), for tests and for a Host with no mail service: an inbound
 * request's body is the mail as JSON (`request` builds one), and each sent mail is kept in `sent`.
 * It takes the body's `authentication` as it is, so it vouches for whatever it is sent: a Host
 * mounts it only where nobody else can reach the inbound route.
 */
export function fakeEmailProvider(): {
  provider: EmailProvider;
  sent: OutboundMail[];
  /** A request to the inbound route carrying `mail`, its fields defaulted. */
  request: (mail?: Partial<InboundMail>) => Request;
} {
  const sent: OutboundMail[] = [];
  const provider: EmailProvider = {
    parseInbound: async (request) => {
      const body: unknown = await request.json().catch(() => undefined);
      const mail = fakeMailSchema.safeParse(body);
      return mail.success ? mail.data : { rejected: "The body isn't a JSON mail" };
    },
    send: async (mail) => {
      sent.push(mail);
    },
  };
  const request = (mail: Partial<InboundMail> = {}) =>
    new Request("http://localhost/api/channels/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "", to: [], ...mail }),
    });
  return { provider, sent, request };
}
