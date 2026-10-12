/**
 * The part of `html-to-text` (10.x, which ships no types) that `fetch-url-tool.ts` uses. Options are
 * typed loosely here: see the package's README for the full set.
 */
declare module "html-to-text" {
  export function convert(html: string, options?: Record<string, unknown>): string;
}
