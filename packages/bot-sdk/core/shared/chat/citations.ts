import { type Citation, type ExcerptCitation, isExcerpt, type Source, sourceKey } from "./sources";

/**
 * Inline citations. The Model cites with ordinary markdown links (`citationPrompt`, and
 * `knowledgePromptOf` for Excerpts); the renderer shows a link whose URL is one of this Message's
 * Sources, or whose `excerpt:<n>` names one of its Excerpts, as that citation's numbered chip. No
 * `[n]` markers from the Model. No server code: safe to import into the browser.
 */

/** The system prompt for a reply that may read the web (search or fetch). */
export const citationPrompt =
  "When you use information from web_search results or from a page you read with fetch_url, " +
  "cite it right after the claim " +
  "with an ordinary markdown link to the result's exact url, using the site's name as the " +
  "link text, for example: TanStack AI supports tool calling ([tanstack.com](https://tanstack.com/ai/latest)). " +
  "Only link to urls that a search returned or a page you read. Don't add numbered markers like [1] or a list " +
  "of sources at the end; the app shows the sources.";

/** The web Source a link in a reply cites, or `null` for a link that stays plain. */
export function citationFor(href: string | undefined, citations: Citation[]): Source | null {
  if (!href) return null;
  const key = sourceKey(href);
  const source = citations.find(
    (citation): citation is Source => !isExcerpt(citation) && sourceKey(citation.url) === key,
  );
  return source ?? null;
}

/** The Excerpt a link in a reply cites by its `excerpt:<n>` label, or `null` for any other link. */
export function excerptFor(
  href: string | undefined,
  citations: Citation[],
): ExcerptCitation | null {
  if (!href) return null;
  return (
    citations.find(
      (citation): citation is ExcerptCitation => isExcerpt(citation) && citation.label === href,
    ) ?? null
  );
}
