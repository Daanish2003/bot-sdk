import type { CuratedModel } from "../chat/models";

/**
 * Which files can be attached, and how big: plain data and pure functions, safe to import into
 * the browser. Images and PDFs go to the Provider as inline base64; text-like files as text, so
 * every Model can read them.
 */

export type AttachmentKind = "text" | "image" | "pdf";

/** What the client and the Shared link see of an attachment: never its bytes. */
export type AttachmentInfo = { id: string; filename: string; mediaType: string; size: number };

/** The largest file that can be attached. */
export const maxAttachmentBytes = 5 * 1024 * 1024;
/** The most attachment bytes one Active Branch may carry; history is resent on every turn. */
export const maxBranchAttachmentBytes = 20 * 1024 * 1024;

const imageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const pdfType = "application/pdf";
const textTypes = [
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
];
/** Text files browsers often give no type, or a wrong one (`.ts` is "video/mp2t"). */
const textExtensions = [
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".log", ".html", ".css", ".scss", ".js", ".jsx", ".mjs",
  ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".php", ".sh", ".sql", ".graphql", ".vue", ".svelte",
]; // prettier-ignore

function hasTextExtension(filename: string) {
  const name = filename.toLowerCase();
  return textExtensions.some((extension) => name.endsWith(extension));
}

/** What a file is to the Provider, or `undefined` when it can't be attached. */
export function attachmentKind(mediaType: string, filename: string): AttachmentKind | undefined {
  if (imageTypes.includes(mediaType)) return "image";
  if (mediaType === pdfType) return "pdf";
  if (mediaType.startsWith("text/") || textTypes.includes(mediaType)) return "text";
  if (hasTextExtension(filename)) return "text";
  return undefined;
}

/** The media type an attachment is stored with: a text-like file without a text type is text/plain. */
export function normalizedMediaType(mediaType: string, filename: string): string {
  const kind = attachmentKind(mediaType, filename);
  if (kind !== "text" || mediaType.startsWith("text/") || textTypes.includes(mediaType)) {
    return mediaType;
  }
  return "text/plain";
}

/** The kinds a Model reads: text always, images and PDFs by its capabilities. */
export function acceptedKinds(
  model: Pick<CuratedModel, "images" | "pdfs"> | undefined,
): AttachmentKind[] {
  if (!model) return [];
  return [
    "text",
    ...(model.images ? (["image"] as const) : []),
    ...(model.pdfs ? (["pdf"] as const) : []),
  ];
}

/** The `accept` attribute of a file input for `kinds`; empty when there are none. */
export function acceptAttribute(kinds: AttachmentKind[]): string {
  return kinds
    .flatMap((kind) =>
      kind === "image"
        ? imageTypes
        : kind === "pdf"
          ? [pdfType]
          : ["text/*", ...textTypes, ...textExtensions],
    )
    .join(",");
}

/** "image", "PDF" or "text file", for messages. */
export function kindLabel(kind: AttachmentKind): string {
  return kind === "image" ? "image" : kind === "pdf" ? "PDF" : "text file";
}

/** "images", "PDFs" or "text files". */
export function kindLabelPlural(kind: AttachmentKind): string {
  return `${kindLabel(kind)}s`;
}
