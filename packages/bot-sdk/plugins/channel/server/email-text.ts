import EmailReplyParser from "email-reply-parser";

import { forwardedEmailLabel, untrustedBlock } from "../../bot/server/routine";
import type { InboundMail } from "./email";

/** The lines that open a forwarded part: Gmail's, Apple Mail's and the older Gmail's. */
const forwardMarker = /^[ \t]*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/im;

/**
 * What the Bot reads from an email (spec #761): the new text only, the quoted history stripped; the
 * subject as a first line unless the mail replies to the Bot's thread (one of its In-Reply-To or
 * References ids is a Bot's, `<id@domain>`); the attachments not kept named in one line;
 * and anything below a forward marker in an untrusted fenced block, as for a webhook's payload.
 * Empty when the mail has no subject line, no new text, no forward and no attachment.
 */
export function emailText(
  mail: Pick<InboundMail, "subject" | "text" | "headers" | "attachments">,
  domain: string,
): string {
  // The marker counts only where the parser shows text, not inside quoted history.
  const visible = new EmailReplyParser().read(mail.text).getVisibleText();
  const marker = forwardMarker.exec(visible);
  const forwarded = marker ? mail.text.slice(mail.text.indexOf(marker[0])).trim() : "";
  const typed = marker ? visible.slice(0, marker.index) : visible;
  const lines = [];
  const subject = oneLine(mail.subject);
  if (subject && !repliesToThread(mail.headers, domain)) lines.push(subject);
  const fresh = typed.trim();
  if (fresh) lines.push(fresh);
  const parts = [lines.join("\n")].filter(Boolean);
  // Names are a sender's text: on one line each, and before the forward, which the reviewer never sees.
  if (mail.attachments.length > 0) {
    parts.push(`Attachments (not kept): ${mail.attachments.map(oneLine).join(", ")}`);
  }
  if (forwarded) parts.push(untrustedBlock(forwardedEmailLabel, forwarded));
  return parts.join("\n\n");
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether the mail answers one of the Bots' mails: its In-Reply-To or References (any case) holds a
 * Message-ID on `domain`, which only the Bots' outbound mail has.
 */
function repliesToThread(headers: Record<string, string>, domain: string): boolean {
  const suffix = `@${domain.toLowerCase()}>`;
  return Object.entries(headers).some(
    ([name, value]) =>
      /^(in-reply-to|references)$/i.test(name) &&
      (value.toLowerCase().match(/<[^<>]*>/g) ?? []).some((id) => id.endsWith(suffix)),
  );
}
