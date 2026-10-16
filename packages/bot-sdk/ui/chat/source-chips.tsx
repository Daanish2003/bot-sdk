import { excerptFor, citationFor } from "../../plugins/assistant/shared/chat/citations";
import type {
  Citation,
  ExcerptCitation,
  Source as NumberedSource,
} from "../../plugins/assistant/shared/chat/sources";
import { useI18n } from "../../core/client/react/provider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Source, SourceContent, SourceTrigger } from "@/components/ui/prompt-kit/source";
import { type ComponentProps, createContext, useContext } from "react";

/** A Source's numbered chip, with a hover card showing its title and snippet. */
export function SourceChip({
  source,
  favicon = false,
}: {
  source: NumberedSource;
  favicon?: boolean;
}) {
  return (
    <Source href={source.url}>
      <SourceTrigger label={source.number} showFavicon={favicon} />
      <SourceContent title={source.title} description={source.snippet} />
    </Source>
  );
}

/**
 * An Excerpt's numbered chip (spec #357, ticket #206). A click opens a popover with its file name
 * and passage; the file itself is never opened. A Shared link's Excerpt has no passage to show.
 */
export function ExcerptChip({ excerpt }: { excerpt: ExcerptCitation }) {
  const { t } = useI18n();
  const heading = t("chat.excerptHeading", { number: excerpt.number });
  return (
    <Popover>
      <PopoverTrigger
        aria-label={heading}
        className="bg-muted text-muted-foreground hover:bg-muted-foreground/30 hover:text-primary inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs tabular-nums transition-colors duration-150"
      >
        {excerpt.number}
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 p-3 text-sm">
        <div className="text-xs text-muted-foreground">{heading}</div>
        <div className="truncate font-medium">{excerpt.fileName}</div>
        {excerpt.text !== undefined && (
          <p className="line-clamp-6 whitespace-pre-line text-muted-foreground">{excerpt.text}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The numbered Source chips under a search row. */
export function SourceChips({ sources }: { sources: NumberedSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <SourceChip key={source.number} source={source} favicon />
      ))}
    </div>
  );
}

/** The citations of the reply whose links render inside it: its web Sources and Excerpts. */
export const ReplySources = createContext<Citation[]>([]);

/** Keeps an Excerpt link's `excerpt:<n>` target, which the markdown renderer would otherwise drop. */
export const replyKeepUrl = (href: string) => /^excerpt:\d+$/.test(href);

/**
 * A link in a reply: a link to one of this Message's Sources or Excerpts (`ReplySources`) is that
 * citation's numbered chip; any other link stays a plain link. Web links open in a new tab. One
 * component type for every render, so chips survive streamed updates (an open hover card stays open).
 */
function ReplyLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const citations = useContext(ReplySources);
  const excerpt = excerptFor(href, citations);
  if (excerpt) {
    return (
      <span className="mx-0.5 inline-flex align-middle">
        <ExcerptChip excerpt={excerpt} />
      </span>
    );
  }
  const source = citationFor(href, citations);
  if (source) {
    return (
      <span className="mx-0.5 inline-flex align-middle">
        <SourceChip source={source} />
      </span>
    );
  }
  // An Excerpt id this reply doesn't have is not a web address: its text stays, without a link.
  if (href && replyKeepUrl(href)) return <span>{children}</span>;
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

/** Markdown renderers for a reply, inside `ReplySources`. */
export const replyComponents = { a: ReplyLink };
