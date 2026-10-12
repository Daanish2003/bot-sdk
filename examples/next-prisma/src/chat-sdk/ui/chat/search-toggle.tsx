import { tavilyService } from "../../core/shared/credentials/services";
import { searchToggle } from "../../core/client/web-search";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { GlobeIcon } from "lucide-react";

import { useOrpc } from "../../core/client/react/provider";
import { useSearchPreference } from "../../core/client/react/search-preference";

/**
 * The Web toggle for `model`: available when the Model has tools (search also needs a Tavily key);
 * `enabled` is what a send's `webSearch` carries (the server re-checks it).
 */
export function useWebSearch(model: string | null | undefined) {
  const orpc = useOrpc();
  const credentials = useQuery(orpc.credentials.list.queryOptions());
  const models = useQuery(orpc.models.list.queryOptions());
  const [on, setOn] = useSearchPreference();
  const toggle = searchToggle({
    // The user's own Tavily key, or the Host's when it offers one (ADR 0007).
    hasTavilyKey:
      (credentials.data?.some((saved) => saved.service === tavilyService) ?? false) ||
      (models.data?.webSearchOnHost ?? false),
    modelTools: models.data?.models.find((candidate) => candidate.id === model)?.tools ?? false,
    on,
  });
  return { ...toggle, on, setOn };
}

/** The composer's Web toggle; disabled with the reason in its tooltip when unavailable. */
export function SearchToggle({ search }: { search: ReturnType<typeof useWebSearch> }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-pressed={search.enabled}
        aria-disabled={!search.available}
        onClick={(event) => {
          // The composer focuses its textarea on clicks.
          event.stopPropagation();
          if (search.available) search.setOn(!search.on);
        }}
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
          search.enabled ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
          !search.available && "cursor-not-allowed opacity-50 hover:bg-transparent",
        )}
      >
        <GlobeIcon className="size-3.5" aria-hidden /> Web
      </TooltipTrigger>
      <TooltipContent>{search.tooltip}</TooltipContent>
    </Tooltip>
  );
}
