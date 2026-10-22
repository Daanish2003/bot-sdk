import type { BotMessage } from "../../bot/shared/turn";
import type { SentFile } from "../../bot/shared/files";
import type { OutboundMail } from "./email";

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
  const paragraphs: Paragraph[] = [{ text: message.text }];
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
    case "routine_approval":
    case "review_approval":
      paragraphs.push(link("Approve or decline in the app"));
      break;
    case undefined:
      break;
    default:
      paragraphs.push(link("Open it in the app"));
  }
  return {
    text: paragraphs.map(plainText).join("\n\n"),
    html: paragraphs.map(htmlOf).join("\n"),
    ...(attachments && { attachments }),
  };
}

type Paragraph = { text: string; href?: string } | { list: string[]; ordered?: boolean };

function plainText(paragraph: Paragraph): string {
  if ("list" in paragraph) {
    return paragraph.list
      .map((item, index) => `${paragraph.ordered === false ? "-" : `${index + 1}.`} ${item}`)
      .join("\n");
  }
  return paragraph.href ? `${paragraph.text}: ${paragraph.href}` : paragraph.text;
}

function htmlOf(paragraph: Paragraph): string {
  if ("list" in paragraph) {
    const tag = paragraph.ordered === false ? "ul" : "ol";
    return `<${tag}>${paragraph.list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
  }
  if (paragraph.href) {
    return `<p><a href="${escapeHtml(paragraph.href)}">${escapeHtml(paragraph.text)}</a></p>`;
  }
  return `<p>${escapeHtml(paragraph.text).replace(/\r?\n/g, "<br>")}</p>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
