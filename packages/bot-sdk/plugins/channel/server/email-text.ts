import EmailReplyParser from "email-reply-parser";

import { forwardedEmailLabel, untrustedBlock } from "../../bot/server/routine";
import type { InboundMail } from "./email";

export const forwardedLabel = forwardedEmailLabel;

/** The lines that open a forwarded part: Gmail's, Apple Mail's and the older Gmail's. */
const forwardMarker = /^[ \t]*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/im;

/**
 * What the Bot reads from an email (spec #761): the new text only, the quoted history stripped; the
 * subject as a first line unless the mail replies to a thread; anything below a forward marker in an
 * untrusted fenced block, as for a webhook's payload; and the attachments named in one line.
 */
export function emailText(
  mail: Pick<InboundMail, "subject" | "text" | "headers" | "attachments">,
): string {
  const marker = forwardMarker.exec(mail.text);
  const typed = marker ? mail.text.slice(0, marker.index) : mail.text;
  const forwarded = marker ? mail.text.slice(marker.index).trim() : "";
  const lines = [];
  const subject = mail.subject.trim();
  if (subject && !repliesToThread(mail.headers)) lines.push(subject);
  const fresh = new EmailReplyParser().read(typed).getVisibleText().trim();
  if (fresh) lines.push(fresh);
  let text = lines.join("\n");
  if (forwarded) text += `${text ? "\n\n" : ""}${untrustedBlock(forwardedLabel, forwarded)}`;
  if (mail.attachments.length > 0) {
    text += `${text ? "\n\n" : ""}Attachments (not kept): ${mail.attachments.join(", ")}`;
  }
  return text;
}

/** Whether the headers say the mail answers another (In-Reply-To or References, any case). */
function repliesToThread(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([name, value]) => /^(in-reply-to|references)$/i.test(name) && value.trim() !== "",
  );
}
