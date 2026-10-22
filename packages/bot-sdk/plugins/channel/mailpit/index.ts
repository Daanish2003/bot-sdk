import { z } from "zod";

import type { EmailProvider, InboundMail } from "../server/email";

/** What Mailpit POSTs for each message it receives (its message summary): only the ID is used. */
const webhookSchema = z.object({ ID: z.string().regex(/^[A-Za-z0-9]+$/) });

const addressSchema = z.object({ Name: z.string().optional(), Address: z.string() });
const messageSchema = z.object({
  MessageID: z.string(),
  From: addressSchema,
  To: z.array(addressSchema),
  Subject: z.string(),
  Text: z.string(),
  Attachments: z.array(z.object({ FileName: z.string() })).nullable(),
});
const headersSchema = z.record(z.string(), z.array(z.string()));

const formatAddress = ({ Name, Address }: z.infer<typeof addressSchema>) =>
  Name ? `${Name} <${Address}>` : Address;

/** `Name <address>` or a bare address as Mailpit's `{Email, Name}`. */
function mailpitAddress(header: string): { Email: string; Name?: string } {
  const bracketed = /^(.*?)\s*<([^<>]*)>\s*$/.exec(header);
  if (!bracketed) return { Email: header.trim() };
  const name = bracketed[1]!.trim().replace(/^"|"$/g, "");
  return name ? { Email: bracketed[2]!.trim(), Name: name } : { Email: bracketed[2]!.trim() };
}

/**
 * The email provider over a local Mailpit (spec #761, ticket #773): Mailpit's received-message
 * webhook POSTs to the Host's inbound route, and the provider fetches that mail from Mailpit's REST
 * API; a mail goes out through its HTTP send API, which takes the Message-ID, In-Reply-To and
 * References headers.
 *
 * Mailpit gives no SPF, DKIM or DMARC verdict, so this provider vouches for every mail it holds with
 * an aligned DMARC pass. That is safe only where nobody else can reach Mailpit or the inbound route:
 * a Host mounts it only on localhost. A webhook that doesn't name a message Mailpit holds is refused.
 */
export function mailpitEmailProvider({
  apiUrl,
  fetch: fetcher = fetch,
}: {
  /** Mailpit's origin, such as `http://localhost:8025`. */
  apiUrl: string;
  fetch?: typeof fetch;
}): EmailProvider {
  const base = apiUrl.replace(/\/+$/, "");
  const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> => {
    const response = await fetcher(`${base}${path}`).catch(() => undefined);
    if (!response?.ok) return undefined;
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    return parsed.success ? parsed.data : undefined;
  };
  return {
    parseInbound: async (request) => {
      const hook = webhookSchema.safeParse(await request.json().catch(() => undefined));
      if (!hook.success) return { rejected: "The body isn't a Mailpit webhook" };
      const { ID } = hook.data;
      const [message, headers] = await Promise.all([
        get(`/api/v1/message/${ID}`, messageSchema),
        get(`/api/v1/message/${ID}/headers`, headersSchema),
      ]);
      if (!message || !headers) return { rejected: "Mailpit holds no such message" };
      const mail: InboundMail = {
        from: formatAddress(message.From),
        to: message.To.map(formatAddress),
        messageId: message.MessageID,
        subject: message.Subject,
        text: message.Text,
        headers: Object.fromEntries(
          Object.entries(headers).map(([name, values]) => [name.toLowerCase(), values.join(", ")]),
        ),
        attachments: (message.Attachments ?? []).map((attachment) => attachment.FileName),
        authentication: { spf: "none", dkim: "none", dmarc: "pass" },
      };
      return mail;
    },
    send: async (mail) => {
      const headers: Record<string, string> = { "Message-ID": mail.messageId };
      if (mail.inReplyTo) headers["In-Reply-To"] = mail.inReplyTo;
      if (mail.references?.length) headers.References = mail.references.join(" ");
      const response = await fetcher(`${base}/api/v1/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          From: mailpitAddress(mail.from),
          To: [mailpitAddress(mail.to)],
          Subject: mail.subject,
          Text: mail.text,
          ...(mail.html ? { HTML: mail.html } : {}),
          Headers: headers,
        }),
      });
      if (!response.ok) {
        throw new Error(`Mailpit refused the mail (${response.status}): ${await response.text()}`);
      }
    },
  };
}
