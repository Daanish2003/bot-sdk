import { numberSources } from "../shared/chat/sources";
import type { WebSearchPart } from "../shared/message-parts";

/**
 * The composer's one Web toggle: search and page reading. Web is available whenever the Model has
 * tools; search needs a Tavily key, so without one Web means fetch only, and the tooltip says so.
 */
export function searchToggle({
  hasTavilyKey,
  modelTools,
  on,
}: {
  hasTavilyKey: boolean;
  modelTools: boolean;
  on: boolean;
}) {
  if (!modelTools) {
    return {
      available: false,
      enabled: false,
      tooltip: "This Model can't use tools, so it can't use the web",
    };
  }
  if (!on) return { available: true, enabled: false, tooltip: "Web off" };
  return {
    available: true,
    enabled: true,
    tooltip: hasTavilyKey
      ? "Web on: search and read pages"
      : "Web on: reads pages you link. Search needs a Tavily key in Keys & settings",
  };
}

const failureText: Record<NonNullable<WebSearchPart["errorReason"]>, string> = {
  invalid_key: "Search failed: Tavily rejected your key.",
  quota_exhausted: "Search failed: Tavily's monthly quota is used up.",
  failed: "Search failed.",
};

/** The one line a search row shows, and whether to link Key settings. */
export function describeSearch(search: WebSearchPart) {
  const query = `"${search.query}"`;
  switch (search.state) {
    case "running":
      return { text: `Searching the web for ${query}…`, keySettings: false };
    case "cancelled":
      return { text: "Search cancelled", keySettings: false };
    case "error": {
      const reason = search.errorReason ?? "failed";
      return { text: failureText[reason], keySettings: reason === "invalid_key" };
    }
    case "done": {
      const count = search.results.length;
      return {
        text:
          count === 0
            ? `No results for ${query}`
            : `Searched ${query} · ${count} ${count === 1 ? "source" : "sources"}`,
        keySettings: false,
      };
    }
  }
}

/**
 * The one line a row of back-to-back searches shows: a single search's own line, the search
 * still running, the last failure when none finished (`failed`), or "Searched 3 times · 12
 * sources" counting distinct Sources.
 */
export function describeSearches(searches: WebSearchPart[]) {
  const keySettings = searches.some((search) => describeSearch(search).keySettings);
  const running = searches.find((search) => search.state === "running");
  const failed = searches.every(
    (search) => search.state === "error" || search.state === "cancelled",
  );
  if (searches.length === 1 || running || failed) {
    return { text: describeSearch(running ?? searches.at(-1)!).text, keySettings, failed };
  }
  const count = numberSources(searches.flatMap((search) => search.results)).length;
  const sources = count === 0 ? "no sources" : `${count} ${count === 1 ? "source" : "sources"}`;
  return { text: `Searched ${searches.length} times · ${sources}`, keySettings, failed };
}

/** A result's domain for display: the hostname without `www.`. */
export function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
