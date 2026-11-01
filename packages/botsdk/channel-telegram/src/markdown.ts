import { bareAddress, inlineText, parseMessage, tableText } from "@botsdk/client/message-format";
import type { Block, Inline } from "@botsdk/client/message-format";

/** Telegram's limit for one message's text, after entities are parsed. */
export const messageLimit = 4096;

/** Room kept in each part for the ` (1/3)` marker, in the converted text. */
const markerRoom = 16;

/** The longest address kept as a link. The text can be cut across parts, and a link's address can't. */
const linkAddressLimit = 2048;

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

type Format = { href?: string; strike?: boolean; bold?: boolean; italic?: boolean };

/** Text with one look. `code` carries no format: Telegram's code can't hold or sit in an entity. */
type Run = Format & { text: string; code?: boolean };

/**
 * One line of a message. Nothing formatted runs over a line's end, so a line reads the same
 * wherever a part is cut, and Telegram's per-line `>` never lands inside an entity.
 */
type Line = { quoted: boolean; runs: Run[] };

/** A code block or table. Telegram's code blocks can't sit in a quote, so this one has left it. */
type Pre = { language: string; text: string };

type Item = Line | Pre;

const isLine = (item: Item): item is Line => "runs" in item;

const isBlank = (item: Item) => isLine(item) && item.runs.length === 0;

/** `nodes` as the lines they make, each break starting a new one. */
function runLines(nodes: readonly Inline[], format: Format = {}): Run[][] {
  const lines: Run[][] = [[]];
  const add = (run: Run) => {
    if (run.text) lines.at(-1)?.push(run);
  };
  const walk = (list: readonly Inline[], current: Format) => {
    for (const node of list) {
      switch (node.type) {
        case "text":
          for (const [at, piece] of node.text.split("\n").entries()) {
            if (at > 0) lines.push([]);
            add({ ...current, text: piece });
          }
          break;
        case "code":
          // A link can't hold code either, so there it is the link's text.
          add(current.href ? { ...current, text: node.text } : { text: node.text, code: true });
          break;
        case "break":
          lines.push([]);
          break;
        case "strong":
          walk(node.children, { ...current, bold: true });
          break;
        case "emphasis":
          walk(node.children, { ...current, italic: true });
          break;
        case "strikethrough":
          walk(node.children, { ...current, strike: true });
          break;
        case "link":
          if (node.href.startsWith("mailto:") || node.href.length > linkAddressLimit) {
            // Written out: a Telegram link is only for a web address (it links an email address
            // itself), and one that long might not fit a message.
            walk(node.children, current);
            if (bareAddress(inlineText(node.children, false)) !== bareAddress(node.href)) {
              add({ ...current, text: ` (${node.href.replace(/^mailto:/, "")})` });
            }
          } else walk(node.children, { ...current, href: node.href });
          break;
      }
    }
  };
  walk(nodes, format);
  return lines;
}

function inlineItems(nodes: readonly Inline[], quoted: boolean, format?: Format): Line[] {
  return runLines(nodes, format).map((runs) => ({ quoted, runs }));
}

function listItems(block: Extract<Block, { type: "list" }>, quoted: boolean): Item[] {
  return block.items.flatMap((item, at) => {
    const marker = block.ordered ? `${block.start + at}. ` : "• ";
    const inner = item.flatMap((one) => blockItems(one, quoted));
    const lines = inner[0] && isLine(inner[0]) ? inner : [{ quoted, runs: [] }, ...inner];
    let lead = marker;
    return lines.map((line) => {
      if (!isLine(line)) return line;
      const runs = [{ text: lead }, ...line.runs];
      lead = " ".repeat(marker.length);
      return { ...line, runs };
    });
  });
}

function blockItems(block: Block, quoted: boolean): Item[] {
  switch (block.type) {
    case "paragraph":
      return inlineItems(block.children, quoted);
    case "heading":
      return inlineItems(block.children, quoted, { bold: true });
    case "code":
      if (!block.text.trim()) return [];
      return [{ language: (block.language ?? "").replace(/[^\w+#.-]/g, ""), text: block.text }];
    case "quote":
      // A quote can't hold a quote: nested ones are one.
      return blocksItems(block.children, true);
    case "list":
      return listItems(block, quoted);
    case "table":
      return tableText(block).trim() ? [{ language: "", text: tableText(block) }] : [];
    case "rule":
      return [];
  }
}

/** `list` as lines, with a blank one between its blocks, in the quote if both sides are. */
function blocksItems(list: readonly Block[], quoted: boolean): Item[] {
  const groups = list.map((block) => blockItems(block, quoted)).filter((items) => items.length > 0);
  return groups.flatMap((items, at) => {
    const before = groups[at - 1]?.at(-1);
    if (!before) return items;
    const inQuote = quoted && isLine(before) && isLine(items[0] as Item);
    return [{ quoted: inQuote, runs: [] }, ...items];
  });
}

function renderRuns(runs: readonly Run[]): string {
  let out = "";
  // Opened in one order, so that what two neighbouring runs share stays open across them. That's
  // what keeps two italics from touching as `__`, which Telegram reads as underline.
  const open: string[] = [];
  const close = (mark: string) => (mark.startsWith("[") ? `](${escapeUrl(mark.slice(1))})` : mark);
  for (const run of runs) {
    const marks = [
      ...(run.href ? [`[${run.href}`] : []),
      ...(run.strike ? ["~"] : []),
      ...(run.bold ? ["*"] : []),
      ...(run.italic ? ["_"] : []),
    ];
    let keep = 0;
    while (keep < open.length && open[keep] === marks[keep]) keep += 1;
    while (open.length > keep) out += close(open.pop() as string);
    for (const mark of marks.slice(keep)) {
      out += mark.startsWith("[") ? "[" : mark;
      open.push(mark);
    }
    out += run.code ? `\`${escapeCode(run.text)}\`` : escapeText(run.text);
  }
  while (open.length > 0) out += close(open.pop() as string);
  return out;
}

function renderItem(item: Item): string {
  return isLine(item)
    ? `${item.quoted ? ">" : ""}${renderRuns(item.runs)}`
    : `\`\`\`${item.language}\n${escapeCode(item.text)}\n\`\`\``;
}

function renderItems(items: readonly Item[]): string {
  return items.map(renderItem).join("\n");
}

/** A line as clean text: a link keeps its address after its text, as `plainText` writes it. */
function plainLine({ quoted, runs }: Line): string {
  if (runs.length === 0) return "";
  let out = quoted ? "  " : "";
  let link = "";
  for (const [at, run] of runs.entries()) {
    out += run.text;
    link = run.href ? link + run.text : "";
    if (run.href && runs[at + 1]?.href !== run.href) {
      if (bareAddress(link) !== bareAddress(run.href)) out += ` (${run.href})`;
      link = "";
    }
  }
  return out;
}

function plainItems(items: readonly Item[]): string {
  return items.map((item) => (isLine(item) ? plainLine(item) : item.text)).join("\n");
}

const itemText = (item: Item) =>
  isLine(item) ? item.runs.map((run) => run.text).join("") : item.text;

/** `item` from `from` to `to`, in the characters of `itemText`. */
function sliceItem(item: Item, from: number, to = Number.POSITIVE_INFINITY): Item {
  if (!isLine(item)) return { ...item, text: item.text.slice(from, to) };
  let at = 0;
  const runs = item.runs.flatMap((run) => {
    const start = at;
    at += run.text.length;
    const text = run.text.slice(Math.max(from - start, 0), Math.max(to - start, 0));
    return text ? [{ ...run, text }] : [];
  });
  return { ...item, runs };
}

/**
 * How much of `text` to cut: the longest prefix whose `length` (given its end) fits `room`,
 * preferring a line end, and always something. Only `text` is ever cut, before any escaping, so an
 * escape or a mark is never split.
 */
function takePart(text: string, room: number, length: (end: number) => number): number {
  if (length(text.length) <= room) return text.length;
  let low = 1;
  // Every character takes at least one.
  let high = Math.min(text.length, room);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (length(mid) <= room) low = mid;
    else high = mid - 1;
  }
  const last = text.charCodeAt(low - 1);
  if (low > 1 && last >= 0xd800 && last <= 0xdbff) low -= 1;
  const lineEnd = text.lastIndexOf("\n", low - 1);
  if (lineEnd > low / 2) return lineEnd + 1;
  const space = text.lastIndexOf(" ", low - 1);
  return space > low / 2 ? space + 1 : low;
}

/** `items` grouped so that each group's rendering fits `room`, cutting an item too long for one. */
function fitItems(items: readonly Item[], room: number): Item[][] {
  const parts: Item[][] = [];
  let part: Item[] = [];
  let size = 0;
  const finish = () => {
    while (part.length > 0 && isBlank(part.at(-1) as Item)) part.pop();
    if (part.length > 0) parts.push(part);
    part = [];
    size = 0;
  };
  for (const whole of items) {
    let item = whole;
    if (part.length > 0 && size + 1 + renderItem(item).length > room) finish();
    if (isBlank(item) && part.length === 0) continue;
    while (renderItem(item).length > room) {
      const rest = item;
      const take = takePart(
        itemText(rest),
        room,
        (end) => renderItem(sliceItem(rest, 0, end)).length,
      );
      const head = sliceItem(rest, 0, take);
      parts.push([isLine(head) ? head : { ...head, text: head.text.replace(/\n$/, "") }]);
      item = sliceItem(rest, take);
    }
    size += (part.length > 0 ? 1 : 0) + renderItem(item).length;
    part.push(item);
  }
  finish();
  return parts;
}

/**
 * One message to send: its MarkdownV2 text, and the clean text to resend if Telegram can't parse
 * it, cut into messages that each fit the limit (clean text can be longer than its conversion).
 */
export type Part = { markdownV2: string; plain: string[] };

/** `text` cut into pieces of at most the limit, preferring line ends; joined, they are `text`. */
function plainPieces(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const take = takePart(rest, messageLimit, (end) => end);
    pieces.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return pieces;
}

/**
 * The parts of a Markdown text: one when it fits Telegram's limit, otherwise parts numbered
 * ` (1/3)`, none when nothing in it can be shown. `control` follows the text as what it is, so
 * nothing in the text can run on into it. The same input always makes the same parts, which a
 * retry's resume counts on.
 */
export function splitParts(markdown: string, control: readonly Block[] = []): Part[] {
  const items = blocksItems([...parseMessage(markdown), ...control], false);
  if (!items.some((item) => itemText(item).trim())) return [];
  const whole = renderItems(items);
  if (whole.length <= messageLimit) {
    return [{ markdownV2: whole, plain: plainPieces(plainItems(items)) }];
  }
  const parts = fitItems(items, messageLimit - markerRoom);
  return parts.map((part, index) => ({
    markdownV2: `${renderItems(part)} \\(${index + 1}/${parts.length}\\)`,
    plain: plainPieces(`${plainItems(part)} (${index + 1}/${parts.length})`),
  }));
}
