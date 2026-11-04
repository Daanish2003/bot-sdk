import type { SentFile } from "@botsdk/client/bot/files";
import { parseMessage, plainText } from "@botsdk/client/message-format";
import { isChannelAnswerable } from "@botsdk/client/bot/rich-control";
import type { BotMessage } from "@botsdk/client/bot/turn";

import type { OutboundMail } from "./email";
import { blocksHtml, escapeHtml } from "./email-html";

/** The most bytes of files one email attaches; over it, the files are a link instead. */
export const maxAttachedBytes = 10 * 1024 * 1024;

/** A file the Bot sent, with its bytes when the blob store still holds them. */
export type FileBytes = { file: SentFile; bytes: Uint8Array | null };

/**
 * One Bot Message as an email's body (spec #761): its text, then its Rich control reduced to text
 * and a link to the Bot's page at `botUrl`. A choice is a numbered list, a Secret request only a
 * link (never answerable by mail), and the Computer, Show me and approval cards one line. `files`
 * are attached when they all fit in `maxAttachedBytes`, otherwise linked.
 */
export function emailBody(
  message: Pick<BotMessage, "text" | "control">,
  { botUrl, files = [] }: { botUrl: string; files?: FileBytes[] },
): Pick<OutboundMail, "text" | "html" | "attachments"> {
  const paragraphs: Paragraph[] = [{ markdown: message.text }];
  let attachments: OutboundMail["attachments"];
  const control = message.control;
  const link = (lead: string): Paragraph => ({ text: lead, href: botUrl });
  switch (control?.kind) {
    case "choice":
      paragraphs.push({
        list: [...control.options, ...(control.other ? ["Other: reply with your own answer"] : [])],
      });
      paragraphs.push(link("Answer in the app"));
      break;
    case "files": {
      const total = files.reduce((sum, { file }) => sum + file.size, 0);
      const whole = files.length > 0 && files.every(({ bytes }) => bytes !== null);
      if (whole && total <= maxAttachedBytes) {
        attachments = files.map(({ file, bytes }) => ({
          name: file.name,
          contentType: file.mediaType,
          content: bytes!,
        }));
      } else {
        paragraphs.push({ list: control.files.map((file) => file.name), ordered: false });
        paragraphs.push(link("Download them in the app"));
      }
      break;
    }
    case "secret":
      paragraphs.push(link("Enter it securely in the app"));
      break;
    case "computer":
      paragraphs.push(link("Take over the Computer in the app"));
      break;
    case "demonstration":
      paragraphs.push(link("Show me in the app"));
      break;
    case "release_approval":
    case "fact_approval":
      paragraphs.push(link("Review it in the app"));
      break;
    case undefined:
      break;
    default:
      paragraphs.push(
        link(
          isChannelAnswerable(control?.kind)
            ? "Approve or decline in the app"
            : "Open it in the app",
        ),
      );
  }
  return { ...mailOf(paragraphs), ...(attachments && { attachments }) };
}

/**
 * A Page as an email's body (ticket #1300): its Markdown `text`, a link `label` to `url`, and a line
 * saying nobody reads a reply, since no Bot has the address it comes from.
 */
export function pageEmailBody(
  text: string,
  { label, url }: { label: string; url: string },
): Pick<OutboundMail, "text" | "html"> {
  return mailOf([
    { markdown: text },
    { text: label, href: url },
    { text: "Replies to this address aren't read." },
  ]);
}

/** `paragraphs` as a mail's plain text and HTML. */
function mailOf(paragraphs: Paragraph[]): Pick<OutboundMail, "text" | "html"> {
  return {
    text: paragraphs.map(paragraphText).filter(Boolean).join("\n\n"),
    html: paragraphs.map(htmlOf).filter(Boolean).join("\n") || "<p></p>",
  };
}

type Paragraph =
  | { markdown: string }
  | { text: string; href?: string }
  | { list: string[]; ordered?: boolean };

function paragraphText(paragraph: Paragraph): string {
  if ("markdown" in paragraph) return plainText(paragraph.markdown);
  if ("list" in paragraph) {
    return paragraph.list
      .map((item, index) => `${paragraph.ordered === false ? "-" : `${index + 1}.`} ${item}`)
      .join("\n");
  }
  return paragraph.href ? `${paragraph.text}: ${paragraph.href}` : paragraph.text;
}

function htmlOf(paragraph: Paragraph): string {
  if ("markdown" in paragraph) return blocksHtml(parseMessage(paragraph.markdown));
  if ("list" in paragraph) {
    const tag = paragraph.ordered === false ? "ul" : "ol";
    return `<${tag}>${paragraph.list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
  }
  if (paragraph.href) {
    return `<p><a href="${escapeHtml(paragraph.href)}">${escapeHtml(paragraph.text)}</a></p>`;
  }
  return `<p>${escapeHtml(paragraph.text)}</p>`;
}

/** A subject that answers `subject`: one "Re: " however many it had, or "Re: <fallback>" when empty. */
export function replySubject(subject: string, fallback: string): string {
  const bare = headerText(subject)
    .replace(/^(re\s*:\s*)+/i, "")
    .trim();
  return `Re: ${bare || headerText(fallback)}`;
}

/** `text` on one line, for a header: a line break can't start another header. */
export const headerText = (text: string) => text.replace(/\s+/g, " ").trim();

/** Whether `files` are attached to one email: they fit in `maxAttachedBytes` in total. */
export function fitsInOneEmail(files: SentFile[]): boolean {
  return files.reduce((sum, file) => sum + file.size, 0) <= maxAttachedBytes;
}

/** `"Name" <address>`, the name quoted and its quotes, backslashes and line breaks made safe. */
export function namedAddress(name: string, address: string): string {
  const safe = name.replace(/[\r\n]+/g, " ").replace(/(["\\])/g, "\\$1");
  return `"${safe}" <${address}>`;
}
