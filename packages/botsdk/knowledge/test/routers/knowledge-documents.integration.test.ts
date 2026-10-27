import { readFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { knowledge } from "../../src";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { insertOwner } from "@ai-chat/test-support/users";

const folder = "/home/user/shared/knowledge";
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const textOf = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const knowledgePaths = (files: Map<string, Uint8Array>) =>
  [...files.keys()].filter((path) => path.startsWith(`${folder}/`)).toSorted();
const pdf = (name = "handbook.pdf", fixtureName = "sample-text.pdf") =>
  new File([fixture(fixtureName)], name, { type: "application/pdf" });
const docx = (name = "plan.docx") => new File([fixture("sample.docx")], name);

/** A DOCX whose one paragraph holds `text`, zipped by hand so a test can make big text small. */
function docxWithText(text: string, name = "long.docx") {
  const entries = {
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [entryName, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const packed = deflateRawSync(raw);
    const nameBytes = Buffer.from(entryName);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(3, 8);
  end.writeUInt16LE(3, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new File([Buffer.concat([...locals, directoryBytes, end])], name);
}

async function setup() {
  const computerFake = fakeComputerProvider();
  const deps = createTestSdk({
    computer: computerFake.provider,
    features: [knowledge()],
  });
  const client = chatRpc({ user: await insertOwner(), deps });
  return { computerFake, client };
}

describe("uploading a PDF or DOCX to Knowledge", { timeout: 30_000 }, () => {
  it("writes a PDF and its readable copy with page markers", async () => {
    const { computerFake, client } = await setup();

    const added = await client.knowledge.uploadDocument({ folder: "hr", file: pdf() });

    expect(added.path).toBe("hr/handbook.pdf");
    expect(knowledgePaths(computerFake.files)).toEqual([
      `${folder}/hr/handbook.pdf`,
      `${folder}/hr/handbook.pdf.md`,
    ]);
    expect(computerFake.files.get(`${folder}/hr/handbook.pdf`)).toEqual(
      new Uint8Array(fixture("sample-text.pdf")),
    );
    expect(textOf(computerFake.files.get(`${folder}/hr/handbook.pdf.md`))).toBe(
      "## Page 1\nHarbour study: tidal flow in the eastern basin.\nQuay 4 sits at 12 m depth.",
    );
  });

  it("writes a DOCX and its readable copy", async () => {
    const { computerFake, client } = await setup();

    await client.knowledge.uploadDocument({ file: docx() });

    expect(knowledgePaths(computerFake.files)).toEqual([
      `${folder}/plan.docx`,
      `${folder}/plan.docx.md`,
    ]);
    expect(textOf(computerFake.files.get(`${folder}/plan.docx.md`))).toContain("Quay 4 12 m");
  });

  it("refuses a scanned PDF with its reason and writes nothing", async () => {
    const { computerFake, client } = await setup();

    await expect(
      client.knowledge.uploadDocument({ file: pdf("scan.pdf", "sample-scanned.pdf") }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { code: "error.knowledgeNoText" },
      message: "This PDF has no text to read (it may be a scan)",
    });
    expect(computerFake.files.size).toBe(0);
  });

  it("refuses a file over 20 MB and writes nothing", async () => {
    const { computerFake, client } = await setup();
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.pdf");

    await expect(client.knowledge.uploadDocument({ file: big })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { code: "error.knowledgeDocumentTooLarge" },
    });
    expect(computerFake.files.size).toBe(0);
  });

  it("refuses converted text over 2 MB and writes nothing", async () => {
    const { computerFake, client } = await setup();

    await expect(
      client.knowledge.uploadDocument({ file: docxWithText("word ".repeat(500_000)) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code: "error.knowledgeTextTooLong" } });
    expect(computerFake.files.size).toBe(0);

    // Just under the cap converts.
    await client.knowledge.uploadDocument({ file: docxWithText("word ".repeat(100_000)) });
    expect(knowledgePaths(computerFake.files)).toHaveLength(2);
  });

  it("refuses a file that is not a PDF or DOCX, or is unreadable, and writes nothing", async () => {
    const { computerFake, client } = await setup();

    await expect(
      client.knowledge.uploadDocument({ file: new File(["x"], "notes.md") }),
    ).rejects.toMatchObject({ data: { code: "error.knowledgeFormat" } });
    await expect(
      client.knowledge.uploadDocument({ file: new File(["not a pdf"], "fake.pdf") }),
    ).rejects.toMatchObject({ data: { code: "error.knowledgeUnreadable" } });
    expect(computerFake.files.size).toBe(0);
  });

  it("refuses the same name unless replace is set, and replace overwrites both files", async () => {
    const { computerFake, client } = await setup();
    await client.knowledge.uploadDocument({ file: pdf() });

    await expect(client.knowledge.uploadDocument({ file: pdf() })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { code: "error.knowledgeExists" },
    });

    computerFake.files.set(`${folder}/handbook.pdf.md`, new TextEncoder().encode("stale"));
    await client.knowledge.uploadDocument({ file: pdf(), replace: true });

    expect(textOf(computerFake.files.get(`${folder}/handbook.pdf.md`))).toContain("## Page 1");
    expect(knowledgePaths(computerFake.files)).toHaveLength(2);
  });

  it("deletes the original and its copy together", async () => {
    const { computerFake, client } = await setup();
    await client.knowledge.uploadDocument({ file: pdf() });
    await client.knowledge.upload({ name: "keep.md", content: "keep" });

    await client.knowledge.remove({ path: "handbook.pdf" });

    expect(knowledgePaths(computerFake.files)).toEqual([`${folder}/keep.md`]);
  });

  it("lists the original once, with its readable copy for the read route", async () => {
    const { client } = await setup();
    await client.knowledge.uploadDocument({ file: pdf() });
    await client.knowledge.upload({ name: "notes.md", content: "n" });

    const listed = await client.knowledge.list();

    expect(listed.files).toEqual([
      {
        path: "handbook.pdf",
        size: fixture("sample-text.pdf").length,
        savedBy: "user",
        readable: "handbook.pdf.md",
      },
      { path: "notes.md", size: 1, savedBy: "user" },
    ]);
    // The copy still counts toward the 50 MB.
    const copy = await client.knowledge.read({ path: "handbook.pdf.md" });
    expect(listed.usage).toBe(fixture("sample-text.pdf").length + copy.size + 1);
    expect(copy.content).toContain("## Page 1");
  });

  it("counts the original and its copy toward the 50 MB cap", async () => {
    const { computerFake, client } = await setup();
    computerFake.files.set(`${folder}/big.txt`, new Uint8Array(50 * 1024 * 1024 - 10));

    await expect(client.knowledge.uploadDocument({ file: pdf() })).rejects.toMatchObject({
      data: { code: "error.knowledgeFull" },
    });
    expect(knowledgePaths(computerFake.files)).toEqual([`${folder}/big.txt`]);
  });
});
