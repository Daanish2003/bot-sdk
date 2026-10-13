import { load } from "cheerio";
import { parse as parseCsv } from "csv-parse/sync";
import mammoth from "mammoth";

import {
  wordMediaType,
  type KnowledgeFailureCode,
  type KnowledgeMediaType,
} from "../../shared/knowledge/kinds";
import {
  ArchiveIntegrityError,
  assertOoxmlArchiveWithinLimits,
  isEncryptedOoxmlContainer,
  ZipBombError,
} from "./ooxml";

/** A file that can't be read as text, with the reason the file shows as failed. */
export class ExtractionFailure extends Error {
  readonly code: KnowledgeFailureCode;

  constructor(code: KnowledgeFailureCode) {
    super(`Knowledge file can't be read: ${code}`);
    this.code = code;
  }
}

/**
 * The text a Knowledge file's passages are cut from, by its media type. Markdown and plain text
 * are read as they are; HTML and DOCX (through mammoth's HTML) are reduced to their text; CSV rows
 * are written with their header names, so every row describes itself. Throws ExtractionFailure.
 */
export async function extractKnowledgeText(
  mediaType: KnowledgeMediaType,
  bytes: Uint8Array,
): Promise<string> {
  switch (mediaType) {
    case "text/markdown":
    case "text/plain":
      return decodeUtf8(bytes);
    case "text/html":
      return htmlToText(decodeUtf8(bytes));
    case "text/csv":
      return csvToText(decodeUtf8(bytes));
    case wordMediaType:
      return docxToText(Buffer.from(bytes));
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExtractionFailure("unreadable");
  }
}

/** The visible text of an HTML document, one line per block, with runs of spaces collapsed. */
function htmlToText(html: string): string {
  const $ = load(html);
  $("script, style, noscript, template").remove();
  // A cell's paragraphs stay on the row's line, so each table row reads as one line.
  $("p, div, section, article, header, footer, h1, h2, h3, h4, h5, h6, li, tr, br, table, pre")
    .not("td *, th *")
    .after("\n");
  $("td, th").after(" ");
  return $.root()
    .text()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** One line per row, each field written as `header: value`. */
function csvToText(text: string): string {
  let rows: Record<string, string>[];
  try {
    rows = parseCsv(text, {
      columns: true,
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch {
    throw new ExtractionFailure("unreadable");
  }
  return rows
    .map((row) =>
      Object.entries(row)
        .map(([header, value]) => `${header}: ${value}`)
        .join(", "),
    )
    .join("\n");
}

/** DOCX through mammoth's HTML, after the encryption and archive-size checks. */
async function docxToText(buffer: Buffer): Promise<string> {
  if (isEncryptedOoxmlContainer(buffer)) throw new ExtractionFailure("encrypted");
  try {
    assertOoxmlArchiveWithinLimits(buffer);
  } catch (error) {
    if (error instanceof ZipBombError) throw new ExtractionFailure("too_large");
    if (error instanceof ArchiveIntegrityError) throw new ExtractionFailure("unreadable");
    throw error;
  }
  let html: string;
  try {
    // Images are dropped rather than embedded as data URIs, which would only bloat the HTML.
    const result = await mammoth.convertToHtml(
      { buffer },
      { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
    );
    html = result.value;
  } catch {
    throw new ExtractionFailure("unreadable");
  }
  return htmlToText(html);
}
