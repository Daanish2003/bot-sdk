import type { I18n, MessageKey } from "../shared/i18n";
import { numberSources } from "../shared/chat/sources";
import { searchErrorCodes } from "../shared/chat/web-search";
import type { WebSearchPart } from "../shared/message-parts";

/**
 * The composer's one Web toggle: search and page reading. Web is available whenever the Model has
 * tools; search needs a Tavily key, so without one Web means fetch only, and the tooltip says so.
 */
export function searchToggle(
  { t }: I18n,
  {
    hasTavilyKey,
    modelTools,
    on,
  }: {
    hasTavilyKey: boolean;
    modelTools: boolean;
    on: boolean;
  },
) {
  if (!modelTools) {
    return { available: false, enabled: false, tooltip: t("chat.webNoTools") };
  }
  if (!on) return { available: true, enabled: false, tooltip: t("chat.webOff") };
  return {
    available: true,
    enabled: true,
    tooltip: hasTavilyKey ? t("chat.webOnSearch") : t("chat.webOnNeedsTavilyKey"),
  };
}

/** The one line a search row shows, and whether to link Key settings. */
export function describeSearch({ t }: I18n, search: WebSearchPart) {
  switch (search.state) {
    case "running":
      return { text: t("chat.searchingFor", { query: search.query }), keySettings: false };
    case "cancelled":
      return { text: t("chat.searchCancelled"), keySettings: false };
    case "error": {
      // A part stores its failure's code; one stored before codes has only its reason.
      const code = search.error?.code ?? searchErrorCodes[search.errorReason ?? "failed"];
      return {
        text: t(code as MessageKey),
        keySettings: code === searchErrorCodes.invalid_key,
      };
    }
    case "done": {
      const count = search.results.length;
      return {
        text:
          count === 0
            ? t("chat.searchNoResults", { query: search.query })
            : t("chat.searchedQuery", { query: search.query, count }),
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
export function describeSearches(i18n: I18n, searches: WebSearchPart[]) {
  const keySettings = searches.some((search) => describeSearch(i18n, search).keySettings);
  const running = searches.find((search) => search.state === "running");
  const failed = searches.every(
    (search) => search.state === "error" || search.state === "cancelled",
  );
  if (searches.length === 1 || running || failed) {
    return {
      text: describeSearch(i18n, running ?? searches.at(-1)!).text,
      keySettings,
      failed,
    };
  }
  const count = numberSources(searches.flatMap((search) => search.results)).length;
  return {
    text: i18n.t("chat.searchedTimes", { count: searches.length, sources: count }),
    keySettings,
    failed,
  };
}

/** A result's domain for display: the hostname without `www.`. */
export function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
