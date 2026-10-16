import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ExtractionFailure,
  extractKnowledgeText,
} from "../../../../plugins/assistant/server/knowledge/extract";
import { pdfMediaType, wordMediaType } from "../../../../plugins/assistant/shared/knowledge/kinds";

const sampleDocx = readFileSync(new URL("./fixtures/sample.docx", import.meta.url));
const samplePdf = readFileSync(new URL("./fixtures/sample-text.pdf", import.meta.url));
const scannedPdf = readFileSync(new URL("./fixtures/sample-scanned.pdf", import.meta.url));
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
