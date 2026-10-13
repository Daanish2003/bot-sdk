/**
 * Which files can be Knowledge files, and how big: plain data and pure functions, safe to import into
 * the browser. This ticket takes Markdown and plain text; the other formats come with their parsers.
 */

/** The largest Knowledge file (ADR 0015, amended 2026-10-13). */
export const maxKnowledgeFileBytes = 20 * 1024 * 1024;

/** How many Knowledge files one Project may hold (spec #357). */
export const knowledgeFilesPerProject = 100;

export type KnowledgeMediaType = "text/markdown" | "text/plain";

/**
 * The media type a Knowledge file is stored with, from its type and name, or `undefined` when it
 * isn't a supported file. Markdown is recognised by its `.md`/`.markdown` name or its type; plain
 * text by `.txt` or its type.
 */
export function knowledgeMediaType(
  mediaType: string,
  filename: string,
): KnowledgeMediaType | undefined {
  const name = filename.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown") || mediaType === "text/markdown") {
    return "text/markdown";
  }
  if (name.endsWith(".txt") || mediaType === "text/plain") return "text/plain";
  return undefined;
}

/** The `accept` attribute of the upload input. */
export const knowledgeAcceptAttribute = ".md,.markdown,.txt,text/markdown,text/plain";

/** Why a Knowledge file failed, as the dictionary key suffix the UI shows (`knowledge.failure.<code>`). */
export const knowledgeFailureCodes = [
  "no_text",
  "unreadable",
  "too_large",
  "no_credentials",
  "failed",
] as const;
export type KnowledgeFailureCode = (typeof knowledgeFailureCodes)[number];
