import { describe, expect, it } from "vitest";

import { artifact, artifactVersion } from "../../../../core/server/db/schema/artifact";
import { storedParts } from "../../../../core/shared/message-parts";
import { chatRpc } from "../../../support/sdk";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { getTestDb } from "../../../support/test-database";
import { insertUser, type TestUser } from "../../../support/users";

const deps = createTestDeps({ artifacts: true });

/** An `artifact` part as a saved version's reply stores it (no content). */
const artifactPart = (artifactId: string, version: number) => ({
  type: "artifact" as const,
  artifactId,
  version,
  title: "Landing page",
  kind: "html" as const,
  state: "done" as const,
});

/** The Artifact row and one version of it, written by `messageId` as the Message that saved it. */
async function seedVersion({
  artifactId,
  conversationId,
  messageId,
  number,
  content,
}: {
  artifactId: string;
  conversationId: string;
  messageId: string;
  number: number;
  content: string;
}) {
  const db = getTestDb();
  if (number === 1) {
    await db.insert(artifact).values({ id: artifactId, conversationId, kind: "html" });
  }
  await db.insert(artifactVersion).values({
    artifactId,
    messageId,
    number,
    title: "Landing page",
    language: null,
    content,
  });
}

/** A reply that saved `version` of `artifactId` (its stored parts name the version, not its content). */
function saveReply({
  conversationId,
  parentId,
  artifactId,
  version,
  content,
  active = false,
}: {
  conversationId: string;
  parentId: string;
  artifactId: string;
  version: number;
  content: string;
  active?: boolean;
}) {
  return insertMessage({
    conversationId,
    parentId,
    role: "assistant",
    text: "",
    active,
    parts: storedParts([artifactPart(artifactId, version)]),
  }).then(async (reply) => {
    await seedVersion({
      artifactId,
      conversationId,
      messageId: reply.id,
      number: version,
      content,
    });
    return reply;
  });
}

/** A Shared link on the Branch that ends at v2, with the owner's v3 made after it. */
async function setup() {
  const owner: TestUser = await insertUser();
  const conv = await insertConversation(owner, { title: "Landing" });
  const question = await insertMessage({
    conversationId: conv.id,
    role: "user",
    text: "Make a page",
  });
  const first = await saveReply({
    conversationId: conv.id,
    parentId: question.id,
    artifactId: "art-page",
    version: 1,
    content: "v1 content",
  });
  const followUp = await insertMessage({
    conversationId: conv.id,
    parentId: first.id,
    role: "user",
    text: "Make it blue",
  });
  const second = await saveReply({
    conversationId: conv.id,
    parentId: followUp.id,
    artifactId: "art-page",
    version: 2,
    content: "v2 content",
    active: true,
  });
  const { token } = await chatRpc({ user: owner, deps }).share.upsert({ conversationId: conv.id });
  return { owner, conv, question, first, followUp, second, token };
}

/** The public read of one version through a Shared link, as a visitor makes it. */
const readShared = (token: string, artifactId: string, number: number) =>
  chatRpc({ deps }).share.artifactVersion({ token, artifactId, number });

describe("a Shared link's Artifact versions (ADR 0004, ADR 0016)", () => {
  it("serves each version written on the shared path, with its content", async () => {
    const { token } = await setup();

    expect(await readShared(token, "art-page", 1)).toMatchObject({
      artifactId: "art-page",
      number: 1,
      kind: "html",
      title: "Landing page",
      content: "v1 content",
    });
    expect(await readShared(token, "art-page", 2)).toMatchObject({
      number: 2,
      content: "v2 content",
    });
  });

  it("shows only the versions up to the shared point once the owner has made v3", async () => {
    const { conv, second, token } = await setup();
    const followUp = await insertMessage({
      conversationId: conv.id,
      parentId: second.id,
      role: "user",
      text: "Make it green",
    });
    await saveReply({
      conversationId: conv.id,
      parentId: followUp.id,
      artifactId: "art-page",
      version: 3,
      content: "v3 content",
      active: true,
    });

    const shared = await chatRpc({ deps }).share.get({ token });
    const versions = shared.messages.flatMap((row) =>
      row.parts.flatMap((part) => (part.type === "tool-call" ? [part.output] : [])),
    );
    expect(versions).toEqual([
      { artifactId: "art-page", version: 1 },
      { artifactId: "art-page", version: 2 },
    ]);
    expect(await readShared(token, "art-page", 2)).toMatchObject({ content: "v2 content" });
    await expect(readShared(token, "art-page", 3)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a version written after the shared point", async () => {
    const { conv, second, token } = await setup();
    const followUp = await insertMessage({
      conversationId: conv.id,
      parentId: second.id,
      role: "user",
      text: "Make it green",
    });
    await saveReply({
      conversationId: conv.id,
      parentId: followUp.id,
      artifactId: "art-page",
      version: 3,
      content: "v3 content",
    });

    await expect(readShared(token, "art-page", 3)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serves the version on the shared path, not a sibling Branch's version with the same number", async () => {
    const { conv, question, token } = await setup();
    // A sibling reply to the first one, which numbers its own v2 along its own path.
    const sibling = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
      parts: storedParts([artifactPart("art-page", 1)]),
    });
    const siblingFollowUp = await insertMessage({
      conversationId: conv.id,
      parentId: sibling.id,
      role: "user",
      text: "Make it red",
    });
    await saveReply({
      conversationId: conv.id,
      parentId: siblingFollowUp.id,
      artifactId: "art-page",
      version: 2,
      content: "other Branch content",
    });

    expect(await readShared(token, "art-page", 2)).toMatchObject({ content: "v2 content" });
  });

  it("refuses a version that exists only on another Branch", async () => {
    const { conv, question, token } = await setup();
    const sibling = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "",
    });
    await seedVersion({
      artifactId: "art-other-branch",
      conversationId: conv.id,
      messageId: sibling.id,
      number: 1,
      content: "not on the shared path",
    });

    await expect(readShared(token, "art-other-branch", 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses an Artifact of another Conversation, even one the owner also holds", async () => {
    const { owner, token } = await setup();
    const elsewhere = await insertConversation(owner, { title: "Elsewhere" });
    const reply = await insertMessage({
      conversationId: elsewhere.id,
      role: "assistant",
      text: "",
    });
    await seedVersion({
      artifactId: "art-elsewhere",
      conversationId: elsewhere.id,
      messageId: reply.id,
      number: 1,
      content: "another Conversation",
    });

    await expect(readShared(token, "art-elsewhere", 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses another user's Artifact", async () => {
    const { token } = await setup();
    const stranger = await insertUser();
    const theirs = await insertConversation(stranger, { title: "Theirs" });
    const reply = await insertMessage({ conversationId: theirs.id, role: "assistant", text: "" });
    await seedVersion({
      artifactId: "art-stranger",
      conversationId: theirs.id,
      messageId: reply.id,
      number: 1,
      content: "not yours to share",
    });

    await expect(readShared(token, "art-stranger", 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses everything once the owner deletes the link", async () => {
    const { owner, conv, token } = await setup();

    await chatRpc({ user: owner, deps }).share.delete({ conversationId: conv.id });

    await expect(readShared(token, "art-page", 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a banned owner's link, as share.get does", async () => {
    const { owner, token } = await setup();
    const bannedDeps = createTestDeps({ artifacts: true, isUserBlocked: (id) => id === owner.id });

    await expect(
      chatRpc({ deps: bannedDeps }).share.artifactVersion({
        token,
        artifactId: "art-page",
        number: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(chatRpc({ deps: bannedDeps }).share.get({ token })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses an unknown token", async () => {
    await setup();

    await expect(readShared("no-such-token", "art-page", 1)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("does not exist while Artifacts are off", async () => {
    const { token } = await setup();

    await expect(
      chatRpc({ deps: createTestDeps({ artifacts: false }) }).share.artifactVersion({
        token,
        artifactId: "art-page",
        number: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
