import type { MessagePart } from "@tanstack/ai";

import type { SearchResult } from "./web-search";

/**
 * The `fetch_url` tool's contract, shared by the server tool and the web app. A fetched page is a
 * Source (ADR 0008 keeps its part a generic `tool_call`). No server code: safe to import into the browser.
 */

export const fetchUrlToolName = "fetch_url";

/** Fetches one reply may make; the next call gets `fetchLimitError` and fetches nothing. */
export const maxFetchesPerReply = 5;

export const fetchLimitError = "fetch limit reached";

/** Why a page couldn't be read. The Model reads the message; the reason is for the chat. */
export type FetchErrorReason =
  | "timed_out"
  | "too_large"
  | "unsupported"
  | "blocked"
  | "http_error"
  | "failed";

/** A page the Model read. `content` is cut to the character cap, and `truncated` says so. */
export type FetchedPage = { url: string; title: string; content: string; truncated?: boolean };

/** The `fetch_url` tool result the Model sees and the chat stores: a page, or a failure with its reason. */
export type FetchUrlOutput = FetchedPage | { error: string; reason?: FetchErrorReason };

/** Characters of a page the Model reads (the rest is cut). */
export const maxFetchedCharacters = 20_000;

/**
 * The page a `tool_call` part of `fetch_url` read, as a Source, or `null` for any other part and
 * for a call that read no page.
 */
export function fetchedSourceOf(part: MessagePart): SearchResult | null {
  return part.type === "tool-call" ? pageSourceOf(part.name, part.output) : null;
}

/** The page a call of `name` read, from its result, as a Source; `null` for any other call. */
export function pageSourceOf(name: string, result: unknown): SearchResult | null {
  if (name !== fetchUrlToolName) return null;
  const output = result as Partial<FetchedPage> | null | undefined;
  if (typeof output?.url !== "string" || typeof output.title !== "string") return null;
  if (typeof output.content !== "string") return null;
  return { title: output.title, url: output.url, snippet: snippetOf(output.content) };
}

/** The first words of a page, for its Source chip. */
function snippetOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
