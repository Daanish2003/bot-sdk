import { Lexer } from "marked";
import type { Token, Tokens } from "marked";
import { mentionedMembers } from "./bot/mentions";

/**
 * A Message's Markdown source, read once for every Channel that isn't the web (spec #1117): the
 * parsed structure a Channel's renderer writes from, and the plain text and one line built on it.
 *
 * The structure holds what is safe to show and nothing else: hidden elements, tags with attributes,
 * comments and images are gone, and a link is only ever `http`, `https` or `mailto`. A bare tag is
 * a word, as in `Array<object>` or `convert <input>`, and stays as written, as it does on the web.
 * It holds text as written, so a renderer escapes all of it for its own format.
 *
 * It has its own entry and the only import of `marked`, so a page that doesn't use it doesn't load
 * `marked`.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "break" }
  | { type: "strong" | "emphasis" | "strikethrough"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; language: string | null; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; align: TableAlign[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "rule" };

/**
 * What stands on both sides of an `*` that is arithmetic and not emphasis. ASCII only: languages
 * written without spaces put marks between letters all the time, and mean them.
 */
const wordChar = /[a-z0-9]/i;

/** The HTML whose content is code, not text to read: it goes with its tags. */
const hiddenTagOpen = /^<(script|style)(?![\w-])/i;
const hiddenTagClose = /^<\/(script|style)(?![\w-])/i;
const lineBreakTag = /^<br\b/i;
/** A tag with only its name, as in `<b>`, `</b>` or `<b/>`. */
const bareTag = /^<\/?[a-z][\w.:-]*\s*\/?>$/i;
/**
 * The elements of HTML, old ones too, and the roots of SVG and MathML. Anything after one's name is
 * an attribute. Anything after another name is words until it has a value, as in `a <x and c> b`.
 */
const htmlElements = new Set(
  (
    "a abbr acronym address applet area article aside audio b base basefont bdi bdo bgsound big blink " +
    "blockquote body br button canvas caption center cite code col colgroup data datalist dd del " +
    "details dfn dialog dir div dl dt em embed fieldset figcaption figure font footer form frame " +
    "frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins isindex kbd " +
    "keygen label legend li link listing main map mark marquee math menu menuitem meta meter multicol " +
    "nav nextid nobr noembed noframes noscript object ol optgroup option output p param picture " +
    "plaintext portal pre progress q rb rp rt rtc ruby s samp script search section select slot small " +
    "source spacer span strike strong style sub summary sup svg table tbody td template textarea tfoot " +
    "th thead time title tr track tt u ul var video wbr xmp"
  ).split(" "),
);
/** A hidden element and what's in it, then any other tag or comment, closed or left open. */
const htmlInBlock =
  /<(script|style)(?![\w-])[\s\S]*?(?:<\/\1\s*>|$)|<!--[\s\S]*?(?:-->|$)|<[/!?]?[a-z](?:"[^"]*"|'[^']*'|[^>"'])*(?:>|$)/gi;

const namedEntities = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

/** How many tags of each name were dropped and not yet closed, across one Message. */
type DroppedTags = Map<string, number>;

/**
 * Whether `raw`, one tag as `marked` or `htmlInBlock` found it, is a word in angle brackets and not
 * a hidden element or a tag with attributes. It holds no other tag to carry through.
 */
function isWordInBrackets(raw: string): boolean {
  if (hiddenTagOpen.test(raw) || hiddenTagClose.test(raw)) return false;
  if (bareTag.test(raw)) return true;
  const name = /^<\/?([a-z][\w-]*)/i.exec(raw)?.[1];
  return name !== undefined && !htmlElements.has(name.toLowerCase()) && !/[<=]/.test(raw.slice(1));
}

/**
 * Whether one tag stays as text, read in the Message's order. A closing tag goes when its opening
 * tag went, so that `<a href="x">here</a>` reads `here`.
 */
function keepsTag(raw: string, dropped: DroppedTags): boolean {
  const name = /^<\/?([a-z][\w.:-]*)/i.exec(raw)?.[1]?.toLowerCase() ?? "";
  const open = dropped.get(name) ?? 0;
  const closing = raw.startsWith("</");
  if (closing && open > 0) {
    dropped.set(name, open - 1);
    return false;
  }
  if (isWordInBrackets(raw)) return true;
  if (!closing) dropped.set(name, open + 1);
  return false;
}

/** `html` without its hidden elements, tags with attributes and comments. */
function withoutHtml(html: string, dropped: DroppedTags): string {
  return html.replace(htmlInBlock, (found) => {
    if (lineBreakTag.test(found)) return "\n";
    return keepsTag(found, dropped) ? found : "";
  });
}

/**
 * A tag `marked` leaves in text: a hidden element's, or an element's with an attribute's value,
 * left open, written with a slash for a space, or from an entity or an escape. Left open, it runs to
 * the next bracket, as it would in a browser. It captures the name of the second kind.
 */
const tagInText =
  /<\/?(?:script|style)(?![\w-])[^<>]*>?|<([a-z][\w-]*)(?:[\s/]+[a-z_:][\w:.-]*)+\s*=[^<>]*>?/gi;

function dropTagsInText(text: string): string {
  return text.replace(tagInText, (found, name?: string) =>
    !name || htmlElements.has(name.toLowerCase()) ? "" : found,
  );
}

/** `text` without those tags. One that dropping another puts back together takes every `<` with it. */
function withoutTagsInText(text: string): string {
  const once = dropTagsInText(text);
  return dropTagsInText(once) === once ? once : once.replaceAll("<", "");
}

/** `nodes` without tags in their text. Text and breaks are read together: a tag can run over lines. */
function withoutTagsInNodes(nodes: Inline[]): Inline[] {
  if (!nodes.some((node) => node.type === "text" && node.text.includes("<"))) return nodes;
  const kept: Inline[] = [];
  let run = "";
  const endRun = () => {
    withoutTagsInText(run)
      .split("\n")
      .forEach((line, at) => {
        if (at > 0) kept.push({ type: "break" });
        if (line) kept.push({ type: "text", text: line });
      });
    run = "";
  };
  for (const node of nodes) {
    if (node.type === "text") run += node.text;
    else if (node.type === "break") run += "\n";
    else {
      endRun();
      kept.push(node);
    }
  }
  endRun();
  return kept;
}

/** The text an entity stands for. `marked` keeps entities as written and leaves this to a renderer. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]+));/gi, (entity, dec, hex, name) => {
    if (name) return namedEntities.get(name.toLowerCase()) ?? entity;
    const code = dec ? Number(dec) : Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** A link's address when it's one a Channel may link to, or `null`. Relative ones have no scheme. */
function safeHref(href: string): string | null {
  try {
    const url = new URL(decodeEntities(href));
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Whether the marked-up `token` sits inside a word, as in `2*3*4` or `5~10~20`. CommonMark calls
 * that emphasis, which would lose the characters of what is nearly always arithmetic or a range.
 */
function isInsideWord(tokens: readonly Token[], at: number): boolean {
  const before = tokens[at - 1];
  const after = tokens[at + 1];
  return (
    before?.type === "text" &&
    after?.type === "text" &&
    wordChar.test(before.raw.at(-1) ?? "") &&
    wordChar.test(after.raw[0] ?? "")
  );
}

/** Adds `node` to `nodes`, joining neighbouring text so that a renderer sees it whole. */
function pushInline(nodes: Inline[], node: Inline): void {
  const last = nodes.at(-1);
  if (node.type === "text" && last?.type === "text") last.text += node.text;
  else nodes.push(node);
}

/** Text with line breaks in it, as a renderer expects it: text and breaks. */
function linesOf(text: string): Inline[] {
  return withoutTagsInNodes(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line, at): Inline[] => [
        ...(at > 0 ? [{ type: "break" } as const] : []),
        { type: "text", text: decodeEntities(line) },
      ]),
  );
}

function inlines(dropped: DroppedTags, tokens: readonly Token[] = []): Inline[] {
  const nodes: Inline[] = [];
  let hidden = false;
  tokens.forEach((token, at) => {
    if (token.type === "html") {
      if (hiddenTagClose.test(token.raw)) hidden = false;
      else if (hidden) return;
      else if (lineBreakTag.test(token.raw)) nodes.push({ type: "break" });
      // Hidden only up to its closing tag: with none, it's a word a Bot wrote about the tag.
      else if (hiddenTagOpen.test(token.raw)) {
        hidden = tokens.slice(at + 1).some((later) => hiddenTagClose.test(later.raw));
      } else if (keepsTag(token.raw, dropped)) pushInline(nodes, { type: "text", text: token.raw });
      return;
    }
    if (hidden) return;
    switch (token.type) {
      case "text":
      case "escape":
        pushInline(nodes, { type: "text", text: decodeEntities((token as Tokens.Text).text) });
        break;
      case "codespan":
        nodes.push({ type: "code", text: (token as Tokens.Codespan).text });
        break;
      case "br":
        nodes.push({ type: "break" });
        break;
      case "strong":
      case "em":
      case "del": {
        const children = inlines(dropped, (token as Tokens.Strong).tokens);
        if (isInsideWord(tokens, at)) {
          const mark = token.raw.match(/^[*~_]+/)?.[0] ?? "";
          for (const node of [
            { type: "text", text: mark } as const,
            ...children,
            { type: "text", text: mark } as const,
          ]) {
            pushInline(nodes, node);
          }
          break;
        }
        if (children.length === 0) break;
        const type =
          token.type === "em" ? "emphasis" : token.type === "del" ? "strikethrough" : "strong";
        nodes.push({ type, children });
        break;
      }
      case "link": {
        const link = token as Tokens.Link;
        const children = inlines(dropped, link.tokens);
        const href = safeHref(link.href);
        if (href && children.length > 0) nodes.push({ type: "link", href, children });
        else for (const child of children) pushInline(nodes, child);
        break;
      }
      // An image, or anything `marked` adds later: not known to be safe.
    }
  });
  return withoutTagsInNodes(nodes);
}

/** A list item's blocks. A task says whether it's done in its first text. */
function listItem(item: Tokens.ListItem, dropped: DroppedTags): Block[] {
  const content = blocks(item.tokens, dropped);
  if (!item.task) return content;
  const children: Inline[] = [{ type: "text", text: item.checked ? "☑ " : "☐ " }];
  const [first, ...rest] = content;
  if (first?.type !== "paragraph") return [{ type: "paragraph", children }, ...content];
  for (const node of first.children) pushInline(children, node);
  return [{ ...first, children }, ...rest];
}

function blocks(tokens: readonly Token[], dropped: DroppedTags): Block[] {
  return tokens.flatMap((token): Block[] => {
    switch (token.type) {
      case "paragraph":
      case "text": {
        const children = inlines(
          dropped,
          (token as Tokens.Paragraph).tokens ?? [
            { type: "text", raw: token.raw, text: (token as Tokens.Text).text },
          ],
        );
        return children.length > 0 ? [{ type: "paragraph", children }] : [];
      }
      case "heading": {
        const { depth, tokens: content } = token as Tokens.Heading;
        const children = inlines(dropped, content);
        return children.length > 0 ? [{ type: "heading", level: depth, children }] : [];
      }
      case "code": {
        const { lang, text } = token as Tokens.Code;
        return [{ type: "code", language: lang?.split(/\s/)[0] || null, text }];
      }
      case "blockquote": {
        const children = blocks((token as Tokens.Blockquote).tokens, dropped);
        return children.length > 0 ? [{ type: "quote", children }] : [];
      }
      case "list": {
        const { ordered, start, items } = token as Tokens.List;
        return [
          {
            type: "list",
            ordered,
            start: typeof start === "number" ? start : 1,
            items: items.map((item) => listItem(item, dropped)),
          },
        ];
      }
      case "table": {
        const { align, header, rows } = token as Tokens.Table;
        return [
          {
            type: "table",
            align,
            header: header.map((cell) => inlines(dropped, cell.tokens)),
            rows: rows.map((row) => row.map((cell) => inlines(dropped, cell.tokens))),
          },
        ];
      }
      case "hr":
        return [{ type: "rule" }];
      case "html": {
        const children = linesOf(withoutHtml(token.raw, dropped));
        return children.length > 0 ? [{ type: "paragraph", children }] : [];
      }
      default:
        // A link definition, a gap between blocks: nothing to show.
        return [];
    }
  });
}

/** Whether all of `source` is one JSON object or array: data, which Markdown would corrupt. */
function isJson(source: string): boolean {
  const text = source.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function jsonBlock(source: string): Block[] {
  return [{ type: "code", language: "json", text: source.trim() }];
}

/**
 * The longest run of inline text `marked` reads in one go. Its time grows with the square of a
 * run's length on some input (a run of nothing but `*a ` takes a minute at 90 KB), so a longer run
 * is read in pieces, cut at whitespace. A mark spanning a cut stays as written.
 */
const inlineRunLimit = 4096;

function piecesOf(run: string): string[] {
  const pieces: string[] = [];
  let rest = run;
  while (rest.length > inlineRunLimit) {
    const space = rest.slice(0, inlineRunLimit).search(/\s\S*$/);
    const cut = space > 0 ? space + 1 : inlineRunLimit;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/**
 * `source`'s tokens. Inline text is read in document order until `inlineBudget` characters have
 * been read, and what's left has no tokens.
 */
function tokenize(source: string, inlineBudget: number): Token[] {
  // A single line break stays a line break (spec #1117).
  const lexer = new Lexer({ gfm: true, breaks: true });
  const tokens = lexer.blockTokens(source.replace(/\r\n?/g, "\n"));
  let read = 0;
  for (const { src, tokens: into } of lexer.inlineQueue) {
    for (const piece of piecesOf(src)) {
      if (read >= inlineBudget) return tokens;
      read += piece.length;
      lexer.inlineTokens(piece, into);
    }
  }
  return tokens;
}

function parse(source: string, inlineBudget: number): Block[] {
  if (isJson(source)) return jsonBlock(source);
  try {
    return blocks(tokenize(source, inlineBudget), new Map());
  } catch {
    // `marked` ran out of stack, as it does on a few thousand nested quotes. Without a parse, what
    // never comes through is taken out by hand and the rest is text.
    const text = withoutHtml(source, new Map())
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/^[>\s]+/gm, "");
    return [{ type: "paragraph", children: linesOf(text) }];
  }
}

/**
 * A Message's Markdown source as the structure a Channel's renderer writes from. A Message that is
 * JSON from start to finish is one `json` code block.
 */
export function parseMessage(source: string): Block[] {
  return parse(source, Number.POSITIVE_INFINITY);
}

/** An address without what a URL adds to it or a writer leaves off, for comparing two. */
export function bareAddress(address: string): string {
  return address.replace(/^(?:https?:\/\/|mailto:)/i, "").replace(/\/$/, "");
}

/** `nodes` as text. `withAddresses` follows a link's text with its address, unless they're the same. */
export function inlineText(nodes: readonly Inline[], withAddresses: boolean): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return "\n";
        case "link": {
          const text = inlineText(node.children, withAddresses);
          const address = node.href.replace(/^mailto:/, "");
          return withAddresses && bareAddress(text) !== bareAddress(node.href)
            ? `${text} (${address})`
            : text;
        }
        default:
          return inlineText(node.children, withAddresses);
      }
    })
    .join("");
}

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line, at) => (at === 0 || !line ? line : `${by}${line}`))
    .join("\n");
}

/** A table as columns of aligned text, with no characters drawing its grid. */
export function tableText({ align, header, rows }: Extract<Block, { type: "table" }>): string {
  const lines = [header, ...rows].map((row) =>
    row.map((cell) => inlineText(cell, true).replace(/\s+/g, " ").trim()),
  );
  const widths = header.map((_, column) =>
    Math.max(...lines.map((line) => line[column]?.length ?? 0)),
  );
  return lines
    .map((line) =>
      line
        .map((cell, column) =>
          align[column] === "right"
            ? cell.padStart(widths[column] ?? 0)
            : cell.padEnd(widths[column] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function blockText(block: Block): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return inlineText(block.children, true);
    case "code":
      return block.text;
    case "quote":
      return `  ${indent(blocksText(block.children), "  ")}`;
    case "list":
      return block.items
        .map((item, at) => {
          const marker = block.ordered ? `${block.start + at}. ` : "• ";
          const text = item.map(blockText).filter(Boolean).join("\n");
          return `${marker}${indent(text, " ".repeat(marker.length))}`;
        })
        .join("\n");
    case "table":
      return tableText(block);
    case "rule":
      return "";
  }
}

/** `list` as clean text, as `plainText` writes a Message's blocks. */
export function blocksText(list: readonly Block[]): string {
  return list.map(blockText).filter(Boolean).join("\n\n");
}

/**
 * A Message as clean text with no Markdown characters: for a Channel, or a part of one, that can't
 * show formatting. A link keeps its address after its text; a table is aligned columns.
 */
export function plainText(source: string): string {
  return blocksText(parseMessage(source));
}

/** The label of a block that has no line of its own to preview. */
const previewLabels = { code: "Code", table: "Table" } as const;

/** The first line of ordinary text in `list`, looking inside quotes and lists. */
function firstOrdinaryLine(list: readonly Block[]): string | null {
  for (const block of list) {
    if (block.type === "paragraph" || block.type === "heading") {
      const line = inlineText(block.children, false)
        .split("\n")
        .map((one) => one.replace(/\s+/g, " ").trim())
        .find(Boolean);
      if (line) return line;
    } else if (block.type === "quote") {
      const line = firstOrdinaryLine(block.children);
      if (line) return line;
    } else if (block.type === "list") {
      for (const item of block.items) {
        const line = firstOrdinaryLine(item);
        if (line) return line;
      }
    }
  }
  return null;
}

/** The first code block or table in `list`, at any depth, as its label. */
function firstLabel(list: readonly Block[]): string | null {
  for (const block of list) {
    if (block.type === "code" || block.type === "table") return previewLabels[block.type];
    const inner =
      block.type === "quote"
        ? firstLabel(block.children)
        : block.type === "list"
          ? firstLabel(block.items.flat())
          : null;
    if (inner) return inner;
  }
  return null;
}

/**
 * How much inline text a one-line preview reads. It needs only the start of a Message, and it runs
 * for every Bot in the list. Code blocks don't count, so the line after a long one is still found.
 */
const oneLineInlineBudget = 4096;

/**
 * A Message as one line of clean text, for a preview: its first line of ordinary text, or "Code" or
 * "Table" when it holds only those, or "" when it holds nothing to show. It isn't cut to any
 * length: that's up to where it's shown.
 */
export function oneLine(source: string): string {
  const parsed = parse(source, oneLineInlineBudget);
  return firstOrdinaryLine(parsed) ?? firstLabel(parsed) ?? "";
}

/** `nodes` as the prose a reader sees: no code, a link as its text, formatting marks gone. */
function proseInline(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "code":
          return " ";
        case "break":
          return "\n";
        default:
          return proseInline(node.children);
      }
    })
    .join("");
}

function proseBlocks(list: readonly Block[]): string {
  return list.map(proseBlock).filter(Boolean).join("\n\n");
}

function proseBlock(block: Block): string {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return proseInline(block.children);
    case "quote":
      return proseBlocks(block.children);
    case "list":
      return block.items.map(proseBlocks).join("\n");
    case "table":
      return [block.header, ...block.rows].map((row) => row.map(proseInline).join("\n")).join("\n");
    case "code":
    case "rule":
      return "";
  }
}

/**
 * The Bots a Room Message mentions (spec #1117), by id: `mentionedMembers` over the Message's
 * prose, not its Markdown source. Code, in a block or in a line, mentions no one, and a name
 * wrapped in formatting (`_@Name_`) does. An escaped `\@Name` reads as the text `@Name`, as it does
 * on screen, so it mentions that Bot too.
 */
export function mentionedInMessage(
  source: string,
  members: readonly { botId: string; name: string }[],
): string[] {
  return mentionedMembers(proseBlocks(parseMessage(source)), members);
}
