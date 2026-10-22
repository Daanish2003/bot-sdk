import { citationFor } from "../../shared/chat/citations";
import type { Source as NumberedSource } from "../../shared/chat/sources";
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

/** The Sources of the reply whose links render inside it. */
export const ReplySources = createContext<NumberedSource[]>([]);

/**
 * A link in a reply: a link to one of this Message's Sources (`ReplySources`) is that Source's
 * numbered chip; any other link stays a plain link. Web links open in a new tab. One component
 * type for every render, so chips survive streamed updates (an open hover card stays open).
 */
function ReplyLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & { node?: unknown }) {
  const source = citationFor(href, useContext(ReplySources));
  if (source) {
    return (
      <span className="mx-0.5 inline-flex align-middle">
        <SourceChip source={source} />
      </span>
    );
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

/** Markdown renderers for a reply, inside `ReplySources`. */
export const replyComponents = { a: ReplyLink };
