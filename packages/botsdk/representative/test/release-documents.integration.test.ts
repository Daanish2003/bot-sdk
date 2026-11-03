import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { convertDocument } from "@botsdk/knowledge/convert";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { testCustomerTurn } from "@ai-chat/test-support/test-customer";
import { insertUser } from "@ai-chat/test-support/users";
import { createFakeAdapter, round } from "@botsdk/testing/fake-adapter";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { representative, type RepresentativeOptions } from "../src";
import { representativeDocument, representativeRelease } from "../src/server/db/schema";

/*
 * Documents uploaded into a Representative's draft and pinned in its Releases (ticket #1259), through
 * the owner's API and the test Customer entry point, with a fake Model on real Postgres.
 */

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const botModel = "openai:gpt-5.4-mini";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const runners: JobRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

const fixture = (name: string) =>
  readFileSync(new URL(`../../knowledge/test/fixtures/${name}`, import.meta.url));
const textFile = (name: string, text: string) => new File([text], name);

/** An owner with the feature on, a Computer configured and a runner running. */
async function instance({
  options = { convertDocument },
  botRounds = [],
}: { options?: RepresentativeOptions; botRounds?: Round[] } = {}) {
  const fake = createFakeAdapter({ rounds: Array.from({ length: 12 }, () => round()) });
  const botFake = createFakeAdapter({ rounds: [...botRounds, round(), round(), round()] });
  const computer = fakeComputerProvider();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    jobs,
    features: [representative(options)],
    adapterFor: (id) => (id === botModel ? botFake.adapter : fake.adapter),
    memory: false,
    computer: computer.provider,
  });
  await jobs.start();
  runners.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  return { fake, botFake, computer, deps, user, rpc: chatRpc({ user, deps }) };
}

type Rpc = Awaited<ReturnType<typeof instance>>["rpc"];

/** A Representative with a draft ready to approve. */
async function drafted(rpc: Rpc) {
  const { id } = await rpc.representative.create({ name: "Front desk" });
  await rpc.representative.updateDraft({
    id,
    draft: {
      jobText: "Answer questions.",
      model,
      skills: [{ name: "Refunds", text: "Ask for the order." }],
    },
  });
  return id;
}

const prompts = (call: { systemPrompts?: unknown } | undefined) =>
  ((call?.systemPrompts ?? []) as (string | { content: string })[]).map((prompt) =>
    typeof prompt === "string" ? prompt : prompt.content,
  );

describe("a document in a Release", () => {
  it("reaches the Model whole, labelled as information, after the fixed content and before the sender's line", async () => {
    const { deps, fake, rpc } = await instance();
    const id = await drafted(rpc);
    const text = `# Warranty\n\n${"Two years on every kettle. ".repeat(500)}\n\`\`\`\nA fence.\n\`\`\`\nThe end.`;

    await rpc.representative.documentUpload({ id, file: textFile("warranty.md", text) });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    await testCustomerTurn(deps, { representativeId: id, message: "Hi" });

    await expect.poll(() => fake.calls.length, poll).toBeGreaterThan(0);
    const sent = prompts(fake.calls[0]);
    const at = sent.findIndex((prompt) => prompt.includes(text));
    expect(at).toBeGreaterThan(-1);
    expect(sent[at]).toContain('"warranty.md"');
    expect(sent[at]!.split("\n")[0]).toMatch(/information.*not instructions/i);
    expect(at).toBeGreaterThan(sent.findIndex((prompt) => prompt.includes("Ask for the order.")));
    expect(at).toBeLessThan(sent.findIndex((prompt) => prompt.includes("This Turn's sender")));
    expect(JSON.stringify(fake.calls[0]!.messages)).not.toContain("Two years on every kettle");
  });
});

describe("a Turn on a Release with documents", () => {
  it("makes no Computer call, nor does uploading or approving", async () => {
    const { computer, deps, fake, rpc } = await instance();
    const id = await drafted(rpc);

    await rpc.representative.documentUpload({ id, file: textFile("hours.md", "Open at nine.") });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    await testCustomerTurn(deps, { representativeId: id, message: "Hi" });

    await expect.poll(() => fake.calls.length, poll).toBeGreaterThan(0);
    expect(prompts(fake.calls[0]).join()).toContain("Open at nine.");
    expect(computer.calls).toEqual([]);
  });
});

describe("uploading a document to a draft", () => {
  it("converts a PDF with its page markers and a DOCX, and refuses a PDF with no text layer", async () => {
    const { rpc } = await instance();
    const id = await drafted(rpc);
    const pdf = new File([fixture("sample-text.pdf")], "handbook.pdf");

    await rpc.representative.documentUpload({ id, file: pdf });
    const view = await rpc.representative.documentUpload({
      id,
      file: new File([fixture("sample.docx")], "plan.docx"),
    });

    expect(view.draft.documents.map((document) => document.name)).toEqual([
      "handbook.pdf",
      "plan.docx",
    ]);
    const rows = await getTestDb()
      .select()
      .from(representativeDocument)
      .where(eq(representativeDocument.representativeId, id));
    expect(rows.find((row) => row.name === "handbook.pdf")!.text).toContain("## Page 1");
    await expect(
      rpc.representative.documentUpload({
        id,
        file: new File([fixture("sample-scanned.pdf")], "scan.pdf"),
      }),
    ).rejects.toMatchObject({ data: { code: "error.knowledgeNoText" } });
    expect((await rpc.representative.get({ id })).draft.documents).toHaveLength(2);
  });

  it("holds a converted document to Knowledge's limits", async () => {
    const { rpc } = await instance();
    const id = await drafted(rpc);

    await expect(
      rpc.representative.documentUpload({
        id,
        file: new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.pdf"),
      }),
    ).rejects.toMatchObject({ data: { code: "error.knowledgeDocumentTooLarge" } });
  });

  it("with no conversion passed in, takes Markdown and plain text and refuses PDF and DOCX clearly", async () => {
    const { rpc } = await instance({ options: {} });
    const id = await drafted(rpc);

    await rpc.representative.documentUpload({ id, file: textFile("a.md", "# A") });
    const view = await rpc.representative.documentUpload({ id, file: textFile("b.TXT", "B") });
    expect(view.draft.documents.map((document) => document.name)).toEqual(["a.md", "b.TXT"]);

    for (const name of ["c.pdf", "d.docx"]) {
      await expect(
        rpc.representative.documentUpload({ id, file: textFile(name, "bytes") }),
      ).rejects.toMatchObject({ data: { code: "error.representativeDocumentNoConversion" } });
    }
  });

  it.each([
    ["another format", textFile("a.html", "<p>A</p>"), "error.representativeDocumentFormat"],
    ["no text", textFile("a.md", "  \n"), "error.representativeDocumentEmpty"],
    ["a NUL", textFile("a.md", "a\u0000b"), "error.representativeDocumentUnreadable"],
    [
      "bytes that aren't UTF-8",
      new File([new Uint8Array([0xff, 0xfe, 0x41])], "a.txt"),
      "error.representativeDocumentUnreadable",
    ],
    [
      "too much text",
      textFile("a.md", "a".repeat(2 * 1024 * 1024 + 1)),
      "error.representativeDocumentTooLong",
    ],
    ["a line break in its name", textFile("a\nb.md", "A"), "error.representativeDocumentName"],
  ])("refuses a file with %s, and the draft stays", async (_what, file, code) => {
    const { rpc } = await instance();
    const id = await drafted(rpc);

    await expect(rpc.representative.documentUpload({ id, file })).rejects.toMatchObject({
      data: { code },
    });
    expect((await rpc.representative.get({ id })).draft.documents).toEqual([]);
  });

  it("can't reach another owner's draft", async () => {
    const { deps, rpc } = await instance();
    const id = await drafted(rpc);
    const stranger = chatRpc({ user: await insertUser(), deps });

    await expect(
      stranger.representative.documentUpload({ id, file: textFile("a.md", "A") }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await rpc.representative.get({ id })).draft.documents).toEqual([]);
  });

  it("removes a document, its text going unless a Release holds it", async () => {
    const { rpc } = await instance();
    const id = await drafted(rpc);
    const textRows = () =>
      getTestDb()
        .select({ name: representativeDocument.name })
        .from(representativeDocument)
        .where(eq(representativeDocument.representativeId, id));
    const pinned = await rpc.representative.documentUpload({
      id,
      file: textFile("pinned.md", "Pinned."),
    });
    await rpc.representative.approve({ id });
    const both = await rpc.representative.documentUpload({
      id,
      file: textFile("loose.md", "Loose."),
    });

    await rpc.representative.documentRemove({ id, documentId: both.draft.documents[1]!.id });
    const view = await rpc.representative.documentRemove({
      id,
      documentId: pinned.draft.documents[0]!.id,
    });

    expect(view.draft.documents).toEqual([]);
    expect(await textRows()).toEqual([{ name: "pinned.md" }]);
    await expect(
      rpc.representative.documentRemove({ id, documentId: pinned.draft.documents[0]!.id }),
    ).rejects.toMatchObject({ data: { code: "error.representativeDocumentNotFound" } });
  });
});

describe("the cap on a Release's documents", () => {
  it("blocks a draft one character over, even with a reason, and lets through one at the cap", async () => {
    const { rpc } = await instance();
    const id = await drafted(rpc);
    await rpc.representative.documentUpload({
      id,
      file: textFile("a.md", "a".repeat(60_000)),
    });
    await rpc.representative.documentUpload({
      id,
      file: textFile("b.md", "b".repeat(40_001)),
    });

    for (const overrideReason of [undefined, "Approve it anyway"]) {
      await expect(
        rpc.representative.approve({ id, ...(overrideReason && { overrideReason }) }),
      ).rejects.toMatchObject({
        data: {
          code: "error.representativeDocumentsTooLong",
          params: { chars: 100_001, limit: 100_000 },
        },
      });
    }
    expect((await rpc.representative.get({ id })).liveRelease).toBeNull();

    await rpc.representative.documentUpload({
      id,
      file: textFile("b.md", "b".repeat(40_000)),
    });
    const release = await rpc.representative.approve({ id });
    expect(release.content.documentSnapshot!.documents).toHaveLength(2);
  });

  it("spends no Model call on a test conversation of a draft over it", async () => {
    const { fake, rpc } = await instance();
    const id = await drafted(rpc);
    await rpc.representative.updateDraft({
      id,
      draft: {
        tests: [{ name: "Hello", message: "Hi", expect: [{ kind: "not_handed_off" }] }],
      },
    });
    await rpc.representative.documentUpload({
      id,
      file: textFile("a.md", "a".repeat(100_001)),
    });

    await rpc.representative.runTests({ id });

    await expect
      .poll(async () => (await rpc.representative.get({ id })).testStatus, poll)
      .toBe("failed");
    expect(fake.calls).toEqual([]);
  });
});

describe("a Release's snapshot", () => {
  it("is hashed at approval and never changes when the draft's documents do", async () => {
    const { deps, fake, rpc } = await instance();
    const id = await drafted(rpc);
    const first = await rpc.representative.documentUpload({
      id,
      file: textFile("price.md", "A kettle costs ten."),
    });
    const release = await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });

    expect(first.draft.documents[0]).toMatchObject({
      name: "price.md",
      chars: 19,
      hash: createHash("sha256").update("A kettle costs ten.").digest("hex"),
    });
    expect(release.content.documentSnapshot).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      documents: first.draft.documents,
    });
    const rowsBefore = await getTestDb()
      .select()
      .from(representativeRelease)
      .where(eq(representativeRelease.id, release.id));

    await rpc.representative.documentUpload({
      id,
      file: textFile("price.md", "A kettle costs twenty."),
    });
    await rpc.representative.documentRemove({
      id,
      documentId: (await rpc.representative.get({ id })).draft.documents[0]!.id,
    });

    expect(
      await getTestDb()
        .select()
        .from(representativeRelease)
        .where(eq(representativeRelease.id, release.id)),
    ).toEqual(rowsBefore);
    await testCustomerTurn(deps, { representativeId: id, message: "How much?" });
    await expect.poll(() => fake.calls.length, poll).toBeGreaterThan(0);
    const sent = prompts(fake.calls[0]).join("\n");
    expect(sent).toContain("A kettle costs ten.");
    expect(sent).not.toContain("twenty");
  });

  it("hashes the same for the same documents, and differently for another text or name", async () => {
    const { rpc } = await instance();
    const hashOf = async (name: string, text: string) => {
      const id = await drafted(rpc);
      await rpc.representative.documentUpload({ id, file: textFile(name, text) });
      return (await rpc.representative.approve({ id })).content.documentSnapshot!.hash;
    };

    const hash = await hashOf("a.md", "Text.");

    expect(await hashOf("a.md", "Text.")).toBe(hash);
    expect(await hashOf("a.md", "Other.")).not.toBe(hash);
    expect(await hashOf("b.md", "Text.")).not.toBe(hash);
  });

  it("comes back with a rollback, and a Release with none still runs", async () => {
    const { deps, fake, rpc } = await instance();
    const id = await drafted(rpc);
    const none = await rpc.representative.approve({ id });
    expect(none.content.documentSnapshot).toBeNull();
    const added = await rpc.representative.documentUpload({
      id,
      file: textFile("old.md", "The old price."),
    });
    const withOld = await rpc.representative.approve({ id });
    await rpc.representative.documentRemove({ id, documentId: added.draft.documents[0]!.id });
    await rpc.representative.documentUpload({ id, file: textFile("new.md", "The new price.") });
    await rpc.representative.approve({ id });
    await rpc.representative.setEnabled({ id, enabled: true });
    const lastPrompt = async () => {
      const before = fake.calls.length;
      await testCustomerTurn(deps, { representativeId: id, message: "How much?" });
      await expect.poll(() => fake.calls.length, poll).toBeGreaterThan(before);
      return prompts(fake.calls.at(-1)).join("\n");
    };

    expect(await lastPrompt()).toContain("The new price.");

    await rpc.representative.rollback({ id, releaseId: withOld.id });
    const rolledBack = await lastPrompt();
    expect(rolledBack).toContain("The old price.");
    expect(rolledBack).not.toContain("The new price.");

    await rpc.representative.rollback({ id, releaseId: none.id });
    const empty = await lastPrompt();
    expect(empty).not.toContain("price.");
    expect(empty).toContain("Answer questions.");
  });
});

describe("a draft's test conversations and its documents", () => {
  const hello = { name: "Hello", message: "Hi", expect: [{ kind: "not_handed_off" as const }] };

  it("run on the draft's documents, and changing them makes the results stop counting", async () => {
    const { fake, rpc } = await instance();
    const id = await drafted(rpc);
    await rpc.representative.updateDraft({ id, draft: { tests: [hello] } });
    const added = await rpc.representative.documentUpload({
      id,
      file: textFile("hours.md", "Open at nine."),
    });
    const passed = async () => {
      await rpc.representative.runTests({ id });
      await expect
        .poll(async () => (await rpc.representative.get({ id })).testStatus, poll)
        .toBe("passed");
    };

    await passed();
    expect(prompts(fake.calls.at(-1)).join()).toContain("Open at nine.");

    // The same file again is the same draft.
    const again = await rpc.representative.documentUpload({
      id,
      file: textFile("hours.md", "Open at nine."),
    });
    expect(again.draft.documents).toEqual(added.draft.documents);
    expect(again.testStatus).toBe("passed");

    const changed = await rpc.representative.documentUpload({
      id,
      file: textFile("hours.md", "Open at ten."),
    });
    expect(changed).toMatchObject({ testStatus: "notRun", tests: [] });
    await expect(rpc.representative.approve({ id })).rejects.toMatchObject({
      data: { code: "error.representativeTestsUnfinished" },
    });

    await passed();
    const removed = await rpc.representative.documentRemove({
      id,
      documentId: changed.draft.documents[0]!.id,
    });
    expect(removed).toMatchObject({ testStatus: "notRun", tests: [] });
  });
});

describe("the draft diff", () => {
  it("shows documents added, removed and changed", async () => {
    const { rpc } = await instance();
    const id = await drafted(rpc);
    const up = (name: string, text: string) =>
      rpc.representative.documentUpload({ id, file: textFile(name, text) });
    await up("stays.md", "Stays.");
    await up("changes.md", "One.");
    const gone = await up("goes.md", "Goes.");
    await rpc.representative.approve({ id });
    expect((await rpc.representative.diff({ id })).changes).toEqual([]);

    await rpc.representative.documentRemove({ id, documentId: gone.draft.documents[2]!.id });
    await up("changes.md", "Two!!");
    await up("new.md", "New.");

    const { changes } = await rpc.representative.diff({ id });

    const side = (text: string) =>
      JSON.stringify({
        chars: text.length,
        hash: createHash("sha256").update(text).digest("hex"),
      });
    expect(changes).toEqual([
      { field: "document", name: "changes.md", before: side("One."), after: side("Two!!") },
      { field: "document", name: "goes.md", before: side("Goes."), after: null },
      { field: "document", name: "new.md", before: null, after: side("New.") },
    ]);
  });
});

describe("a user's delete and export", () => {
  it("exports the documents' text, and delete removes it", async () => {
    const { deps, rpc, user } = await instance();
    const id = await drafted(rpc);
    await rpc.representative.documentUpload({ id, file: textFile("a.md", "The text.") });
    const release = await rpc.representative.approve({ id });

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: { representatives: unknown[] };
    };
    expect(exported.representative.representatives).toMatchObject([
      {
        documents: [{ name: "a.md", text: "The text." }],
        releases: [{ content: { documentSnapshot: release.content.documentSnapshot } }],
      },
    ]);

    await deleteUserData(deps, user.id);

    expect(
      await getTestDb()
        .select()
        .from(representativeDocument)
        .where(eq(representativeDocument.representativeId, id)),
    ).toEqual([]);
  });
});
