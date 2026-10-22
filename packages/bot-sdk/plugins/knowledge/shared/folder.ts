/** A user's Knowledge folder on their Computer, shared by all of their Bots (ADR 0025). */
export const knowledgeDirectory = "/home/user/shared/knowledge";

/** The most all of a user's Knowledge may hold, in bytes, checked at upload. */
export const knowledgeLimitBytes = 50 * 1024 * 1024;

/** The formats a user can add as they are. */
export const knowledgeExtensions = [".md", ".txt", ".html", ".csv"] as const;

/** The formats the server converts to readable Markdown, saved beside the original as `<name>.md`. */
export const knowledgeDocumentExtensions = [".pdf", ".docx"] as const;

/** The largest PDF or DOCX a user can upload, in bytes. */
export const knowledgeDocumentLimitBytes = 20 * 1024 * 1024;

/** The most readable text a converted file may produce, in bytes. */
export const knowledgeTextLimitBytes = 2 * 1024 * 1024;

/** The path of a PDF or DOCX's readable copy, or undefined for any other file. */
export function readableCopyPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  return knowledgeDocumentExtensions.some((extension) => lower.endsWith(extension))
    ? `${path}.md`
    : undefined;
}
