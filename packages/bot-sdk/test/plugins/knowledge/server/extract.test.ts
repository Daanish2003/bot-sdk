import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ExtractionFailure,
  extractKnowledgeText,
  pdfMediaType,
  wordMediaType,
} from "@botsdk/knowledge/server/extract";

const sampleDocx = readFileSync(new URL("../fixtures/sample.docx", import.meta.url));
const samplePdf = readFileSync(new URL("../fixtures/sample-text.pdf", import.meta.url));
const scannedPdf = readFileSync(new URL("../fixtures/sample-scanned.pdf", import.meta.url));
const encode = (text: string) => new TextEncoder().encode(text);

/** The reason a Knowledge file fails to extract, or undefined when it extracts. */
async function failureOf(attempt: Promise<string>) {
  try {
    await attempt;
    return undefined;
  } catch (error) {
    if (error instanceof ExtractionFailure) return error.code;
    throw error;
  }
}

/** A ZIP whose only entry declares `uncompressedBytes` but holds no data, as a zip bomb does. */
function zipDeclaring(uncompressedBytes: number) {
  const name = Buffer.from("word/document.xml");
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt32LE(uncompressedBytes, 24);
  directory.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  return Buffer.concat([directory, name, end]);
}

/**
 * A PDF with one page per text, in Helvetica. With `brokenSecondPage`, the page tree also lists a
 * second page whose object isn't a page, so reading it fails.
 */
function pdfWithPages(texts: string[], { brokenSecondPage = false } = {}) {
  const objects: string[] = [];
  const pageIds = texts.map((_, index) => 4 + index * 2);
  const brokenId = 4 + texts.length * 2;
  const kids = [...pageIds, ...(brokenSecondPage ? [brokenId] : [])];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (const [index, text] of texts.entries()) {
    const id = pageIds[index]!;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[id] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> " +
      `/Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  if (brokenSecondPage) objects[brokenId] = "42";
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(body);
}

describe("extracting the text of a DOCX", () => {
  it("reads its paragraphs and table rows in order", async () => {
    const text = await extractKnowledgeText(wordMediaType, sampleDocx);

    expect(text).toContain("Thesis plan");
    expect(text).toContain("The Harbour study covers tidal flow in the eastern basin.");
    expect(text).toContain("Station Depth\nQuay 4 12 m");
  });

  it("fails as encrypted for a password-protected package", async () => {
    const ole2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const streams = Buffer.concat([
      Buffer.from("EncryptionInfo", "utf16le"),
      Buffer.from("EncryptedPackage", "utf16le"),
    ]);

    expect(
      await failureOf(extractKnowledgeText(wordMediaType, Buffer.concat([ole2, streams]))),
    ).toBe("encrypted");
  });

  it("fails as too large for an archive that declares more than 150 MB", async () => {
    const bomb = zipDeclaring(200 * 1024 * 1024);

    expect(await failureOf(extractKnowledgeText(wordMediaType, bomb))).toBe("too_large");
  });

  it("fails as unreadable for bytes that are not an archive", async () => {
    expect(await failureOf(extractKnowledgeText(wordMediaType, encode("not a Word file")))).toBe(
      "unreadable",
    );
  });
});

describe("extracting the text of HTML", () => {
  it("keeps the visible text, one line per block, and drops scripts and styles", async () => {
    const html =
      "<html><head><style>p { color: red }</style><script>track()</script></head>" +
      "<body><h1>Title</h1><p>First <b>para</b>.</p><ul><li>one</li><li>two</li></ul></body></html>";

    expect(await extractKnowledgeText("text/html", encode(html))).toBe(
      "Title\nFirst para.\none\ntwo",
    );
  });
});

describe("extracting the text of CSV", () => {
  it("writes each row with its header names, without a byte-order mark on the first name", async () => {
    const csv = "﻿name,age\nAda,36\nGrace,85\n";

    expect(await extractKnowledgeText("text/csv", encode(csv))).toBe(
      "name: Ada, age: 36\nname: Grace, age: 85",
    );
  });

  it("fails as unreadable for a row that breaks the quoting", async () => {
    expect(await failureOf(extractKnowledgeText("text/csv", encode('a,b\n"open,1\n')))).toBe(
      "unreadable",
    );
  });
});

describe("extracting the text of Markdown and plain text", () => {
  it("reads them as they are", async () => {
    expect(await extractKnowledgeText("text/markdown", encode("# Notes\n\nBody"))).toBe(
      "# Notes\n\nBody",
    );
  });

  it("fails as unreadable for bytes that are not UTF-8", async () => {
    expect(await failureOf(extractKnowledgeText("text/plain", new Uint8Array([0xff, 0xfe])))).toBe(
      "unreadable",
    );
  });
});

describe("extracting the text of a PDF", () => {
  it("reads the text layer, one line per text line", async () => {
    expect(await extractKnowledgeText(pdfMediaType, samplePdf)).toBe(
      "Harbour study: tidal flow in the eastern basin.\nQuay 4 sits at 12 m depth.",
    );
  });

  it("fails as no text for a scanned PDF with no text layer", async () => {
    expect(await failureOf(extractKnowledgeText(pdfMediaType, scannedPdf))).toBe("no_text");
  });

  it("fails as unreadable for bytes that are not a PDF", async () => {
    expect(await failureOf(extractKnowledgeText(pdfMediaType, encode("not a PDF")))).toBe(
      "unreadable",
    );
  });
});

describe("converting a document for Knowledge", () => {
  it("marks each PDF page so a Bot can cite it", async () => {
    expect(await extractKnowledgeText(pdfMediaType, samplePdf, { pageMarkers: true })).toBe(
      "## Page 1\nHarbour study: tidal flow in the eastern basin.\nQuay 4 sits at 12 m depth.",
    );
  });

  it("fails as too long once the text passes maxBytes, without reading the pages after", async () => {
    // The second page can't be read, so reading it fails as unreadable.
    const pdf = pdfWithPages(["First page text that is long enough"], { brokenSecondPage: true });
    expect(await failureOf(extractKnowledgeText(pdfMediaType, pdf))).toBe("unreadable");

    expect(await failureOf(extractKnowledgeText(pdfMediaType, pdf, { maxBytes: 20 }))).toBe(
      "too_long",
    );
  });

  it("counts the page markers and line breaks toward maxBytes", async () => {
    const text =
      "## Page 1\nHarbour study: tidal flow in the eastern basin.\nQuay 4 sits at 12 m depth.";
    const size = Buffer.byteLength(text);
    expect(
      await extractKnowledgeText(pdfMediaType, samplePdf, { pageMarkers: true, maxBytes: size }),
    ).toBe(text);
    expect(
      await failureOf(
        extractKnowledgeText(pdfMediaType, samplePdf, { pageMarkers: true, maxBytes: size - 1 }),
      ),
    ).toBe("too_long");
  });

  it("fails a DOCX as too long over maxBytes", async () => {
    expect(await failureOf(extractKnowledgeText(wordMediaType, sampleDocx, { maxBytes: 10 }))).toBe(
      "too_long",
    );
  });

  it("refuses a scanned PDF even with page markers", async () => {
    expect(
      await failureOf(extractKnowledgeText(pdfMediaType, scannedPdf, { pageMarkers: true })),
    ).toBe("no_text");
  });
});
