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
  files: z
    .array(z.object({ name: z.string(), contentType: z.string(), base64: z.string() }))
    .optional()
    .transform((files) =>
      files?.map((file) => {
        const content = Uint8Array.from(Buffer.from(file.base64, "base64"));
        return {
          name: file.name,
          contentType: file.contentType,
          size: content.byteLength,
          read: async () => content,
        };
      }),
    ),
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
  /**
   * A request to the inbound route carrying `mail`, its fields defaulted, and `files` as its
   * attachments (named in `attachments` too).
   */
  request: (
    mail?: Partial<Omit<InboundMail, "files">>,
    files?: { name: string; contentType: string; content: string | Uint8Array }[],
  ) => Request;
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
  const request = (
    mail: Partial<Omit<InboundMail, "files">> = {},
    files?: { name: string; contentType: string; content: string | Uint8Array }[],
  ) =>
    new Request("http://localhost/api/channels/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "",
        to: [],
        ...mail,
        ...(files && {
          attachments: files.map((file) => file.name),
          files: files.map((file) => ({
            name: file.name,
            contentType: file.contentType,
            base64: Buffer.from(file.content).toString("base64"),
          })),
        }),
      }),
    });
  return { provider, sent, request };
}
