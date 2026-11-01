import type { Block, Inline } from "@botsdk/client/message-format";

/**
 * A Message's parsed Markdown as the HTML part of an email (spec #1117). Every text is escaped and
 * every tag is written here, so nothing a Bot wrote is HTML. `parseMessage` has already dropped
 * raw HTML and images and kept only `http`, `https` and `mailto` links. Styles are inline, as mail
 * clients ignore a stylesheet.
 */
export function blocksHtml(blocks: readonly Block[]): string {
  return blocks.map(blockHtml).join("\n");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const cell = "border:1px solid #ccc;padding:4px 8px;";
const mono = "font-family:monospace;";

function blockHtml(block: Block): string {
  switch (block.type) {
    case "paragraph":
      return `<p>${inlinesHtml(block.children)}</p>`;
    case "heading": {
      const tag = `h${Math.min(Math.max(block.level, 1), 6)}`;
      return `<${tag}>${inlinesHtml(block.children)}</${tag}>`;
    }
    case "code":
      return `<pre style="${mono}background:#f4f4f4;padding:8px;overflow:auto;"><code>${escapeHtml(block.text)}</code></pre>`;
    case "quote":
      return `<blockquote style="margin:0 0 0 4px;padding-left:12px;border-left:3px solid #ccc;">${blocksHtml(block.children)}</blockquote>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      const items = block.items.map((item) => `<li>${itemHtml(item)}</li>`).join("");
      return `<${tag}${start}>${items}</${tag}>`;
    }
    case "table": {
      const align = (column: number) => {
        const side = block.align[column];
        return side ? `${cell}text-align:${side};` : cell;
      };
      const row = (tag: "th" | "td", cells: Inline[][]) =>
        `<tr>${cells.map((one, column) => `<${tag} style="${align(column)}">${inlinesHtml(one)}</${tag}>`).join("")}</tr>`;
      return `<table style="border-collapse:collapse;">${row("th", block.header)}${block.rows.map((one) => row("td", one)).join("")}</table>`;
    }
    case "rule":
      return "<hr>";
  }
}

/** A list item's blocks: a lone paragraph is its text without a paragraph's margins. */
function itemHtml(item: readonly Block[]): string {
  if (item.length === 1 && item[0]?.type === "paragraph") return inlinesHtml(item[0].children);
  return blocksHtml(item);
}

function inlinesHtml(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return escapeHtml(node.text);
        case "code":
          return `<code style="${mono}">${escapeHtml(node.text)}</code>`;
        case "break":
          return "<br>";
        case "strong":
          return `<strong>${inlinesHtml(node.children)}</strong>`;
        case "emphasis":
          return `<em>${inlinesHtml(node.children)}</em>`;
        case "strikethrough":
          return `<del>${inlinesHtml(node.children)}</del>`;
        case "link":
          return `<a href="${escapeHtml(node.href)}">${inlinesHtml(node.children)}</a>`;
      }
    })
    .join("");
}
