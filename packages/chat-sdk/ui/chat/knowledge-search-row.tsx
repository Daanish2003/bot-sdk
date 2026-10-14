import type { KnowledgeSearchView } from "../../core/shared/chat/knowledge-search";
import type { MessageKey } from "../../core/shared/i18n";
import { cn } from "@/lib/utils";
import { BookOpenIcon, ChevronRightIcon, LoaderIcon } from "lucide-react";
import { useId, useState } from "react";

import { useI18n } from "../../core/client/react/provider";

/**
 * One Knowledge search of a reply (spec #357, ticket #206): a slim line with its state and what it
 * found, which expands to each passage's file name and text. A Shared link shows no text.
 */
export function KnowledgeSearchRow({ search }: { search: KnowledgeSearchView }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const running = search.state === "running";
  const expandable = search.excerpts.length > 0;

  const text = (() => {
    switch (search.state) {
      case "running":
        return t("chat.knowledgeSearching", { query: search.query });
      case "cancelled":
        return t("chat.searchCancelled");
      case "error":
        return t((search.error?.code ?? "chat.knowledgeFailed") as MessageKey);
      case "done":
        return t("chat.knowledgeSearched", {
          query: search.query,
          count: search.excerpts.length,
        });
    }
  })();

  return (
    <div className="flex max-w-[80ch] flex-col gap-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        {running ? (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <BookOpenIcon className="size-3.5 shrink-0" aria-hidden />
        )}
        <span role="status" className={cn("truncate", search.state === "error" && "italic")}>
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
      </div>
      {open && (
        <ol id={listId} className="space-y-2 border-l pl-3">
          {search.excerpts.map((excerpt, index) => (
            <li key={index} className="space-y-0.5">
              <span className="font-medium text-foreground">{excerpt.fileName}</span>
              {excerpt.text !== undefined && <p className="line-clamp-3">{excerpt.text}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
