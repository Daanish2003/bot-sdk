import CSSMatrix from "@thednp/dommatrix";
import { load } from "cheerio";
import { parse as parseCsv } from "csv-parse/sync";
import mammoth from "mammoth";

import {
  pdfMediaType,
  wordMediaType,
  type KnowledgeFailureCode,
  type KnowledgeMediaType,
} from "../../assistant/shared/knowledge/kinds";
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
 * are written with their header names, so every row describes itself. A PDF gives its text layer;
 * a scan with none fails as no_text. Throws ExtractionFailure.
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
    case pdfMediaType:
      return pdfToText(bytes);
  }
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfJsLoading: Promise<PdfJs> | undefined;

/**
 * pdf.js builds `new DOMMatrix()` while it loads, and Node has none, so a pure-JS one is set first
 * (spec #357; no native binary). The import is dynamic so the polyfill is in place before it runs.
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfJsLoading ??= (async () => {
    globalThis.DOMMatrix ??= CSSMatrix as unknown as typeof globalThis.DOMMatrix;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return pdfJsLoading;
}

/**
 * The text layer of a PDF, one line per text line, pages in order. A PDF with no text layer (a
 * scan) fails as no_text: there is nothing to search without OCR, which is left out.
 *
 * This runs in-process, not in a worker_threads worker, by the owner's decision on #368: the job
 * runner is already off the request path, and the SDK ships TypeScript source, so there is no
 * built worker entry for a Host to bundle.
 */
async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await loadPdfJs();
  let document: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    }).promise;
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") {
      throw new ExtractionFailure("encrypted");
    }
    throw new ExtractionFailure("unreadable");
  }

  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          pages.push(line);
          line = "";
        }
      }
      if (line) pages.push(line);
      page.cleanup();
    }
    const text = pages
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0)
      .join("\n");
    if (text.length === 0) throw new ExtractionFailure("no_text");
    return text;
  } catch (error) {
    if (error instanceof ExtractionFailure) throw error;
    throw new ExtractionFailure("unreadable");
  } finally {
    await document.destroy();
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
