import { sourceKey, type Source } from "../../core/shared/chat/sources";
import type { WebSearchPart } from "../../core/shared/message-parts";
import { cn } from "@/lib/utils";
import { ChevronRightIcon, GlobeIcon, LoaderIcon } from "lucide-react";
import { useId, useState } from "react";

import { describeSearch, describeSearches, domainOf } from "../../core/client/web-search";

import { SourceChips } from "./source-chips";

import { useByok } from "../../core/client/react/byok";
import { useChatAdapter } from "../../core/client/react/provider";

/**
 * Back-to-back web searches in a reply (often just one): a slim line with their state, announced
 * as it changes, and the numbered chips of the Sources they found. `sources` are the whole
 * Message's, so the numbers match its citations. The row expands to each search's query and its
 * results' titles, domains and snippets.
 */
export function SearchRow({ searches, sources }: { searches: WebSearchPart[]; sources: Source[] }) {
  const { Link } = useChatAdapter();
  const byok = useByok();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const { text, keySettings, failed } = describeSearches(searches);
  const several = searches.length > 1;
  const expandable = several || searches.some((search) => search.results.length > 0);
  const running = searches.some((search) => search.state === "running");
  const found = new Set(searches.flatMap((search) => search.results.map((r) => sourceKey(r.url))));
  const rowSources = sources.filter((source) => found.has(sourceKey(source.url)));

  return (
    <div className="flex max-w-[80ch] flex-col gap-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        {running ? (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <GlobeIcon className="size-3.5 shrink-0" aria-hidden />
        )}
        <span role="status" className={cn("truncate", failed && "italic")}>
          {expandable ? (
            <button
              type="button"
              className="hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((value) => !value)}
            >
              {text}
              <ChevronRightIcon
                className={cn("ml-1 inline size-3.5 transition-transform", open && "rotate-90")}
                aria-hidden
              />
            </button>
          ) : (
            text
          )}
        </span>
        {keySettings && byok && (
          <Link page={{ to: "keys" }} className="font-medium underline underline-offset-2">
            Key settings
          </Link>
        )}
      </div>
      {open && (
        <div id={listId} className="space-y-3 border-l pl-3">
          {searches.map((search) => (
            <div key={search.toolCallId} className="space-y-2">
              {several && <p className="italic">{describeSearch(search).text}</p>}
              <SearchResults search={search} sources={sources} />
            </div>
          ))}
        </div>
      )}
      <SourceChips sources={rowSources} />
    </div>
  );
}

function SearchResults({ search, sources }: { search: WebSearchPart; sources: Source[] }) {
  if (search.results.length === 0) return null;
  const numberOf = (url: string) =>
    sources.find((source) => sourceKey(source.url) === sourceKey(url))?.number;
  return (
    <ol className="space-y-2">
      {search.results.map((result) => (
        <li key={result.url} className="space-y-0.5">
          <span className="mr-1.5 tabular-nums">{numberOf(result.url)}.</span>
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="font-medium text-foreground hover:underline"
          >
            {result.title}
          </a>
          <span className="ml-2">{domainOf(result.url)}</span>
          <p className="line-clamp-2">{result.snippet}</p>
        </li>
      ))}
    </ol>
  );
}
