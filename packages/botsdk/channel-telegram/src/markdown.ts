/** Telegram's limit for one message's text, after entities are parsed. */
export const messageLimit = 4096;

/** Room kept in each part for the ` (1/3)` marker, in the converted text. */
const markerRoom = 16;

const special = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escapes plain text for MarkdownV2. */
function escapeText(text: string): string {
  return text.replace(special, "\\$&");
}

/** Inside `code` and code blocks only the backtick and the backslash are escaped. */
function escapeCode(text: string): string {
  return text.replace(/[`\\]/g, "\\$&");
}

/** A link's target escapes only the closing parenthesis and the backslash. */
function escapeUrl(url: string): string {
  return url.replace(/[)\\]/g, "\\$&");
}

const inline =
  /\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)([^\n*]+?)\*|(?<!\w)_(?!\s)([^\n_]+?)_(?!\w)|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|`([^`\n]+)`/s;

/** Converts Markdown without code blocks: bold, italic, inline code and links. */
function convertInline(text: string): string {
  let out = "";
  let rest = text;
  for (let match = inline.exec(rest); match; match = inline.exec(rest)) {
    out += escapeText(rest.slice(0, match.index));
    const [, bold, underBold, star, under, label, url, code] = match;
    if (bold !== undefined || underBold !== undefined) {
      out += `*${convertInline((bold ?? underBold) as string)}*`;
    } else if (star !== undefined || under !== undefined) {
      out += `_${convertInline((star ?? under) as string)}_`;
    } else if (label !== undefined) {
      out += `[${convertInline(label)}](${escapeUrl(url as string)})`;
    } else {
      out += `\`${escapeCode(code as string)}\``;
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return out + escapeText(rest);
}

const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;

/**
 * Converts Markdown (bold, italic, code, code blocks, links) to Telegram's MarkdownV2, escaping
 * every other special character. An unclosed code block runs to the end.
 */
export function toMarkdownV2(markdown: string): string {
  let out = "";
  let last = 0;
  for (const match of markdown.matchAll(fence)) {
    out += convertInline(markdown.slice(last, match.index));
    const language = (match[1] ?? "").trim().replace(/[^\w+#.-]/g, "");
    out += `\`\`\`${language}\n${escapeCode((match[2] ?? "").replace(/\n$/, ""))}\n\`\`\``;
    last = match.index + match[0].length;
  }
  return out + convertInline(markdown.slice(last));
}

/** Cuts the longest prefix of `text` whose conversion fits `room`, preferring a line end. */
function takePart(text: string, room: number): number {
  if (toMarkdownV2(text).length <= room) return text.length;
  let low = 1;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (toMarkdownV2(text.slice(0, mid)).length <= room) low = mid;
    else high = mid - 1;
  }
  const last = text.charCodeAt(low - 1);
  if (last >= 0xd800 && last <= 0xdbff) low -= 1;
  const lineEnd = text.lastIndexOf("\n", low - 1);
  if (lineEnd > low / 2) return lineEnd + 1;
  const space = text.lastIndexOf(" ", low - 1);
  return space > low / 2 ? space + 1 : low;
}

/** One message to send: its MarkdownV2 text, and the plain text to resend if Telegram can't parse it. */
export type Part = { markdownV2: string; plain: string };

/**
 * The parts of a Markdown text: one when it fits Telegram's limit, otherwise parts numbered
 * ` (1/3)`. A code block cut by a part is closed there and reopened in the next.
 */
export function splitParts(markdown: string): Part[] {
  const whole = toMarkdownV2(markdown);
  if (whole.length <= messageLimit) return [{ markdownV2: whole, plain: markdown }];
  const sources: string[] = [];
  let rest = markdown;
  let reopen = "";
  while (rest.length > 0) {
    const text = reopen + rest;
    const room = messageLimit - markerRoom - 4;
    const take = Math.max(takePart(text, room), reopen.length + 1);
    let part = text.slice(0, take);
    rest = text.slice(take);
    const fences = part.match(/```/g)?.length ?? 0;
    const open = fences % 2 === 1;
    if (open && rest.length > 0) {
      const language = /```([^\n`]*)\n(?:(?!```)[\s\S])*$/.exec(part)?.[1] ?? "";
      part = `${part.replace(/\n?$/, "\n")}\`\`\``;
      reopen = `\`\`\`${language}\n`;
    } else {
      reopen = "";
    }
    sources.push(part);
  }
  return sources.map((source, index) => ({
    markdownV2: `${toMarkdownV2(source)} \\(${index + 1}/${sources.length}\\)`,
    plain: `${source} (${index + 1}/${sources.length})`,
  }));
}

/** The MarkdownV2 text of each part of `markdown`. */
export function toParts(markdown: string): string[] {
  return splitParts(markdown).map((part) => part.markdownV2);
}
