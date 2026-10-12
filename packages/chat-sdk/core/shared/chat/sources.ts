import type { WebSearchPart } from "../message-parts";
import type { MessagePart } from "@tanstack/ai";

import { fetchedSourceOf, pageSourceOf } from "./fetch-url";
import { toolCallOf, type ToolCallView } from "./tool-call";
import { type SearchResult, webSearchOf } from "./web-search";

/**
 * A reply's Sources and how its parts group for display. Computed by the renderer from the
 * Message's parts, never stored. No server code: safe to import into the browser.
 */

/** One web page a reply's searches returned, numbered per Message. */
export type Source = { number: number; url: string; title: string; snippet: string };

/**
 * A reply's parts as shown, in stream order: text, a row of back-to-back searches, or one tool call
 * other than a search, with its own row.
 */
export type ReplySegment =
  | { type: "text"; key: string; content: string }
  | { type: "searches"; key: string; searches: WebSearchPart[] }
  | { type: "tool"; key: string; call: ToolCallView };

/**
 * The key two URLs share when they are the same Source: the URL without its fragment or a
 * trailing slash.
 */
export function sourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/** Sources numbered by first appearance and deduped by URL: search results and fetched pages alike. */
export function numberSources(found: SearchResult[]): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const result of found) {
    const key = sourceKey(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      number: sources.length + 1,
      url: result.url,
      title: result.title,
      snippet: result.snippet,
    });
  }
  return sources;
}

/** The Source a tool call's page is, among the Message's `sources`, for its chip under the call row; none for other calls. */
export function pageSourcesOf(call: ToolCallView, sources: Source[]): Source[] {
  const page = pageSourceOf(call.name, call.result);
  if (!page) return [];
  return sources.filter((source) => sourceKey(source.url) === sourceKey(page.url));
}

/** Every Source of a Message's parts, numbered in stream order across its searches and fetched pages. */
export function sourcesOf(parts: MessagePart[]): Source[] {
  return numberSources(
    parts.flatMap((part): SearchResult[] => {
      const page = fetchedSourceOf(part);
      return page ? [page] : (webSearchOf(part)?.results ?? []);
    }),
  );
}

/**
 * A reply's text and searches in stream order. Back-to-back searches merge into one segment;
 * only non-empty text separates them. Other parts (thinking) are shown elsewhere.
 */
export function replySegments(parts: MessagePart[]): ReplySegment[] {
  const segments: ReplySegment[] = [];
  parts.forEach((part, index) => {
    if (part.type === "text") {
      if (part.content)
        segments.push({ type: "text", key: `text-${index}`, content: part.content });
      return;
    }
    const search = webSearchOf(part);
    if (!search) {
      // A search that never ran (over the limit) shows nothing; any other tool call gets a row.
      const call = toolCallOf(part);
      if (call) segments.push({ type: "tool", key: `tool-${index}`, call });
      return;
    }
    const last = segments.at(-1);
    if (last?.type === "searches") last.searches.push(search);
    else segments.push({ type: "searches", key: search.toolCallId, searches: [search] });
  });
  return segments;
}
