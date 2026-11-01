import { Lexer } from "marked";
import type { Token, Tokens } from "marked";

/**
 * A Message's Markdown source, read once for every Channel that isn't the web (spec #1117): the
 * parsed structure a Channel's renderer writes from, and the plain text and one line built on it.
 *
 * The structure holds what is safe to show and nothing else: raw HTML and images are gone, and a
 * link is only ever `http`, `https` or `mailto`. It holds text as written, so a renderer escapes
 * all of it for its own format.
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

/** A word character: what stands on both sides of an `*` that is arithmetic and not emphasis. */
const wordChar = /[\p{L}\p{N}]/u;

/** The HTML whose content is code, not text to read: it goes with its tags. */
const hiddenTagOpen = /^<(script|style)\b/i;
const hiddenTagClose = /^<\/(script|style)\b/i;

const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The text an entity stands for. `marked` keeps entities as written and leaves this to a renderer. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]+));/gi, (entity, dec, hex, name) => {
    if (name) return namedEntities[name.toLowerCase()] ?? entity;
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

function inlines(tokens: readonly Token[] = []): Inline[] {
  const nodes: Inline[] = [];
  let hidden = false;
  tokens.forEach((token, at) => {
    if (token.type === "html") {
      if (hiddenTagOpen.test(token.raw)) hidden = true;
      else if (hiddenTagClose.test(token.raw)) hidden = false;
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
        if (isInsideWord(tokens, at)) {
          pushInline(nodes, { type: "text", text: decodeEntities(token.raw) });
          break;
        }
        const children = inlines((token as Tokens.Strong).tokens);
        if (children.length === 0) break;
        const type =
          token.type === "em" ? "emphasis" : token.type === "del" ? "strikethrough" : "strong";
        nodes.push({ type, children });
        break;
      }
      case "link": {
        const link = token as Tokens.Link;
        const children = inlines(link.tokens);
        const href = safeHref(link.href);
        if (href && children.length > 0) nodes.push({ type: "link", href, children });
        else for (const child of children) pushInline(nodes, child);
        break;
      }
      // An image, or anything `marked` adds later: not known to be safe.
    }
  });
  return nodes;
}

function tableCell(cell: Tokens.TableCell): Inline[] {
  return inlines(cell.tokens);
}

function blocks(tokens: readonly Token[]): Block[] {
  return tokens.flatMap((token): Block[] => {
    switch (token.type) {
      case "paragraph":
      case "text": {
        const children = inlines(
          (token as Tokens.Paragraph).tokens ?? [
            { type: "text", raw: token.raw, text: (token as Tokens.Text).text },
          ],
        );
        return children.length > 0 ? [{ type: "paragraph", children }] : [];
      }
      case "heading": {
        const { depth, tokens: content } = token as Tokens.Heading;
        const children = inlines(content);
        return children.length > 0 ? [{ type: "heading", level: depth, children }] : [];
      }
      case "code": {
        const { lang, text } = token as Tokens.Code;
        return [{ type: "code", language: lang?.split(/\s/)[0] || null, text }];
      }
      case "blockquote": {
        const children = blocks((token as Tokens.Blockquote).tokens);
        return children.length > 0 ? [{ type: "quote", children }] : [];
      }
      case "list": {
        const { ordered, start, items } = token as Tokens.List;
        return [
          {
            type: "list",
            ordered,
            start: typeof start === "number" ? start : 1,
            items: items.map((item) => blocks(item.tokens)),
          },
        ];
      }
      case "table": {
        const { align, header, rows } = token as Tokens.Table;
        return [
          {
            type: "table",
            align,
            header: header.map(tableCell),
            rows: rows.map((row) => row.map(tableCell)),
          },
        ];
      }
      case "hr":
        return [{ type: "rule" }];
      default:
        // Raw HTML, a link definition, a gap between blocks: nothing to show.
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

/** `source` shown exactly as written: harmless, as a code block's text is only ever text. */
function literal(source: string, language: string | null): Block[] {
  return [{ type: "code", language, text: source.trim() }];
}

/**
 * A Message's Markdown source as the structure a Channel's renderer writes from. A Message that is
 * JSON from start to finish is one `json` code block, and so is the very rare source `marked`
 * can't read (it runs out of stack on a few thousand nested quotes), which is shown as written.
 */
export function parseMessage(source: string): Block[] {
  if (isJson(source)) return literal(source, "json");
  try {
    // A single line break stays a line break (spec #1117).
    return blocks(Lexer.lex(source, { gfm: true, breaks: true }));
  } catch {
    return literal(source, null);
  }
}

/** `nodes` as text. `withAddresses` follows a link's text with its address, unless they're the same. */
function inlineText(nodes: readonly Inline[], withAddresses: boolean): string {
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
          return withAddresses && text !== address && text !== node.href
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
function tableText({ align, header, rows }: Extract<Block, { type: "table" }>): string {
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

function blocksText(list: readonly Block[]): string {
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
 * How much of a Message's source a one-line preview reads. A preview needs only the start, and it
 * runs for every Bot in the list, while `marked` takes quadratic time on some input: a Message of
 * nothing but `*a ` costs seconds at tens of KB.
 */
const oneLineSourceLimit = 4096;

/**
 * A Message as one line of clean text, for a preview: its first line of ordinary text, or "Code" or
 * "Table" when it holds only those, or "" when it holds nothing to show. It isn't cut to any
 * length: that's up to where it's shown.
 */
export function oneLine(source: string): string {
  const parsed = isJson(source)
    ? literal(source, "json")
    : parseMessage(source.slice(0, oneLineSourceLimit));
  return firstOrdinaryLine(parsed) ?? firstLabel(parsed) ?? "";
}
