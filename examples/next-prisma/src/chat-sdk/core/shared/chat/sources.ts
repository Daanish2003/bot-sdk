import type { GeneratedImagePart, WebSearchPart } from "../message-parts";
import type { MessagePart } from "@tanstack/ai";

import { fetchedSourceOf, pageSourceOf } from "./fetch-url";
import { generatedImageOf } from "./generated-image";
import { type KnowledgeSearchView, knowledgeSearchOf } from "./knowledge-search";
import { toolCallOf, type ToolCallView } from "./tool-call";
import { type SearchResult, webSearchOf } from "./web-search";

/**
 * A reply's Sources and how its parts group for display. Computed by the renderer from the
 * Message's parts, never stored. No server code: safe to import into the browser.
 */

/** One web page a reply's searches returned, numbered per Message. */
export type Source = { number: number; url: string; title: string; snippet: string };

/**
 * One Excerpt a reply's Knowledge searches returned, numbered per Message with the Sources (spec
 * #357, ticket #206). `label` is the id the Model cites (`excerpt:<n>`); `text` is absent on a
 * Shared link.
 */
export type ExcerptCitation = { number: number; label: string; fileName: string; text?: string };

/** A numbered citation of a reply: a web Source or an Excerpt. */
export type Citation = Source | ExcerptCitation;

/** Whether a citation is an Excerpt rather than a web Source. */
export function isExcerpt(citation: Citation): citation is ExcerptCitation {
  return "label" in citation;
}

/**
 * A reply's parts as shown, in stream order: text, a row of back-to-back searches, or one tool call
 * other than a search, with its own row.
 */
export type ReplySegment =
  | { type: "text"; key: string; content: string }
  | { type: "searches"; key: string; searches: WebSearchPart[] }
  | { type: "tool"; key: string; call: ToolCallView }
  | { type: "image"; key: string; image: GeneratedImagePart }
  | { type: "knowledge"; key: string; search: KnowledgeSearchView };

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
export function pageSourcesOf(call: ToolCallView, sources: Citation[]): Source[] {
  const page = pageSourceOf(call.name, call.result);
  if (!page) return [];
  return sources.filter(
    (source): source is Source =>
      !isExcerpt(source) && sourceKey(source.url) === sourceKey(page.url),
  );
}

/** The web Sources among a Message's citations, numbered as they are in the shared sequence. */
export function webSourcesOf(citations: Citation[]): Source[] {
  return citations.filter((citation): citation is Source => !isExcerpt(citation));
}

/**
 * Every citation of a Message's parts, numbered in stream order by first appearance: web Sources
 * (from its searches and fetched pages, deduped by URL) and Excerpts (one per label) share the one
 * sequence.
 */
export function sourcesOf(parts: MessagePart[]): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const knowledge = knowledgeSearchOf(part);
    if (knowledge) {
      for (const excerpt of knowledge.excerpts) {
        if (excerpt.label === undefined) continue;
        citations.push({
          number: citations.length + 1,
          label: excerpt.label,
          fileName: excerpt.fileName,
          ...(excerpt.text !== undefined && { text: excerpt.text }),
        });
      }
      continue;
    }
    const page = fetchedSourceOf(part);
    const results: SearchResult[] = page ? [page] : (webSearchOf(part)?.results ?? []);
    for (const result of results) {
      const key = sourceKey(result.url);
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({
        number: citations.length + 1,
        url: result.url,
        title: result.title,
        snippet: result.snippet,
      });
    }
  }
  return citations;
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
    const image = generatedImageOf(part);
    if (image) {
      segments.push({ type: "image", key: `image-${index}`, image });
      return;
    }
    const knowledge = knowledgeSearchOf(part);
    if (knowledge) {
      segments.push({ type: "knowledge", key: knowledge.toolCallId, search: knowledge });
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
