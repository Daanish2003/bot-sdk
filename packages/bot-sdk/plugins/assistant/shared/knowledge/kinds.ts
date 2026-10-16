/**
 * Which files can be Knowledge files, and how big: plain data and pure functions, safe to import into
 * the browser. The supported formats are listed once, in `knowledgeFormats`; the upload's accept
 * attribute, the empty state and the server's type check all read from it.
 */

/** The largest Knowledge file (ADR 0015, amended 2026-10-13). */
export const maxKnowledgeFileBytes = 20 * 1024 * 1024;

/** How many Knowledge files one Project may hold (spec #357). */
export const knowledgeFilesPerProject = 100;

export const wordMediaType =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const pdfMediaType = "application/pdf";

export type KnowledgeMediaType =
  | "text/markdown"
  | "text/plain"
  | "text/html"
  | "text/csv"
  | typeof wordMediaType
  | typeof pdfMediaType;

/** Each supported format: the media type it is stored with, its file extensions and the types browsers may send. */
const knowledgeFormats: {
  mediaType: KnowledgeMediaType;
  extensions: readonly string[];
  types: readonly string[];
}[] = [
  { mediaType: "text/markdown", extensions: [".md", ".markdown"], types: ["text/markdown"] },
  { mediaType: "text/plain", extensions: [".txt"], types: ["text/plain"] },
  { mediaType: "text/html", extensions: [".html", ".htm"], types: ["text/html"] },
  { mediaType: "text/csv", extensions: [".csv"], types: ["text/csv"] },
  { mediaType: wordMediaType, extensions: [".docx"], types: [wordMediaType] },
  { mediaType: pdfMediaType, extensions: [".pdf"], types: [pdfMediaType] },
];

/** The extensions a Knowledge file can have, for the empty state and the upload's accept attribute. */
export const knowledgeFileExtensions = knowledgeFormats.flatMap((format) => format.extensions);

/**
 * The media type a Knowledge file is stored with, from its name, or from its type when the name
 * isn't recognised. `undefined` when it isn't a supported file.
 */
export function knowledgeMediaType(
  mediaType: string,
  filename: string,
): KnowledgeMediaType | undefined {
  const name = filename.toLowerCase();
  const byName = knowledgeFormats.find((format) =>
    format.extensions.some((extension) => name.endsWith(extension)),
  );
  if (byName) return byName.mediaType;
  return knowledgeFormats.find((format) => format.types.includes(mediaType))?.mediaType;
}

/** The `accept` attribute of the upload input. */
export const knowledgeAcceptAttribute = [
  ...knowledgeFileExtensions,
  ...knowledgeFormats.flatMap((format) => format.types),
].join(",");

/** Why a Knowledge file failed, as the dictionary key suffix the UI shows (`knowledge.failure.<code>`). */
export const knowledgeFailureCodes = [
  "no_text",
  "unreadable",
  "encrypted",
  "too_large",
  "no_credentials",
  "failed",
] as const;
export type KnowledgeFailureCode = (typeof knowledgeFailureCodes)[number];
