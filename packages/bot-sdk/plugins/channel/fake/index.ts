import type { EmailProvider, InboundMail, OutboundMail } from "../server/email";

/**
 * A fake email provider (spec #761), for tests and for a Host with no mail service: an inbound
 * request's body is the mail as JSON (`request` builds one), and each sent mail is kept in `sent`.
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
      try {
        const mail = (await request.json()) as Partial<InboundMail>;
        if (typeof mail.from !== "string" || !Array.isArray(mail.to)) {
          return { rejected: "A mail needs from and to" };
        }
        return { ...defaults, ...mail } as InboundMail;
      } catch {
        return { rejected: "The body isn't a JSON mail" };
      }
    },
    send: async (mail) => {
      sent.push(mail);
    },
  };
  const request = (mail: Partial<InboundMail> = {}) =>
    new Request("http://localhost/api/channels/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...defaults, ...mail }),
    });
  return { provider, sent, request };
}

const defaults: InboundMail = {
  from: "",
  to: [],
  messageId: "",
  subject: "",
  text: "",
  headers: {},
  attachments: [],
  authentication: { spf: "none", dkim: "none", dmarc: "none" },
};
