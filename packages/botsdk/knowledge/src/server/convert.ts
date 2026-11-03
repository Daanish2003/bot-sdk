import { rpcError } from "@botsdk/bot/rpc-error";
import {
  knowledgeDocumentExtensions,
  knowledgeDocumentLimitBytes,
  knowledgeTextLimitBytes,
} from "../shared/folder";
import { ExtractionFailure, extractKnowledgeText, pdfMediaType, wordMediaType } from "./extract";

const failureError = (name: string, code: ExtractionFailure["code"], pdf: boolean) => {
  switch (code) {
    case "no_text":
      return pdf
        ? rpcError(
            "BAD_REQUEST",
            "error.knowledgeNoText",
            "This PDF has no text to read (it may be a scan)",
          )
        : rpcError("BAD_REQUEST", "error.knowledgeNoDocText", "This document has no text to read");
    case "encrypted":
      return rpcError(
        "BAD_REQUEST",
        "error.knowledgeEncrypted",
        "That file is password-protected",
        {
          name,
        },
      );
    case "too_large":
      return rpcError(
        "BAD_REQUEST",
        "error.knowledgeTooComplex",
        "That file is too complex to read",
        { name },
      );
    case "too_long":
      return rpcError("BAD_REQUEST", "error.knowledgeTextTooLong", "That file has too much text", {
        name,
      });
    default:
      return rpcError("BAD_REQUEST", "error.knowledgeUnreadable", "That file can't be read", {
        name,
      });
  }
};

/**
 * The readable text of a PDF or DOCX (PDFs carry `## Page N` markers), needing no Computer. Refused
 * for another format, a file over 20 MB, a scan or unreadable file, or text over 2 MB (a PDF stops
 * converting once it passes that). It runs on the request: see `extract.ts` for what bounds it.
 */
export async function convertDocument(file: File): Promise<string> {
  const { name } = file;
  const lower = name.toLowerCase();
  if (!knowledgeDocumentExtensions.some((extension) => lower.endsWith(extension))) {
    throw rpcError(
      "BAD_REQUEST",
      "error.knowledgeFormat",
      "Knowledge converts PDF and DOCX files",
      {
        name,
        types: knowledgeDocumentExtensions.join(", "),
      },
    );
  }
  if (file.size > knowledgeDocumentLimitBytes) {
    throw rpcError("BAD_REQUEST", "error.knowledgeDocumentTooLarge", "That file is over 20 MB", {
      name,
    });
  }
  const isPdf = lower.endsWith(".pdf");
  let text: string;
  try {
    text = await extractKnowledgeText(
      isPdf ? pdfMediaType : wordMediaType,
      new Uint8Array(await file.arrayBuffer()),
      { pageMarkers: isPdf, maxBytes: knowledgeTextLimitBytes },
    );
  } catch (caught) {
    if (caught instanceof ExtractionFailure) throw failureError(name, caught.code, isPdf);
    throw caught;
  }
  if (text.trim() === "") throw failureError(name, "no_text", isPdf);
  return text;
}
