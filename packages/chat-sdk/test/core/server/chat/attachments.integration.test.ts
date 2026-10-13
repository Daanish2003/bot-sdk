import { attachment, messageAttachment } from "../../../../core/server/db/schema/attachment";
import { message } from "../../../../core/server/db/schema/chat";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { maxAttachmentBytes } from "../../../../core/shared/attachments/kinds";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { insertAttachment, linkTestAttachments } from "../../../support/attachments";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { insertUser, type TestUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
import type { ChatCommand } from "../../../../core/shared/chat/command";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const openaiModel = "openai:gpt-5.6";
const mb = 1024 * 1024;
const base64 = (contents: string) => Buffer.from(contents).toString("base64");

/** A signed-in user with Anthropic and OpenAI credentials, an empty Conversation and a fake adapter. */
async function setup() {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds: [round(text("Got it."))] });
  const deps = createTestDeps({ adapterFor: () => fake.adapter });
  for (const service of ["anthropic", "openai"] as const) {
    await saveCredentials(deps, user.id, {
      service,
      fields: { apiKey: `${service}-test-key` },
      hint: "…-key",
      verified: true,
    });
  }
  // Titled, so no title is generated in the background (a second adapter call).
  const conv = await insertConversation(user, { title: "Attachments" });
  const send = (command: Partial<ChatCommand> = {}, as: TestUser = user) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "What is this?",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      as,
      deps,
    );
  return { user, deps, fake, conv, send, client: chatRpc({ user, deps }) };
}

async function messagesOf(deps: AppDeps, conversationId: string) {
  return deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt), asc(message.role));
}

async function linksOf(deps: AppDeps, messageId: string) {
  const rows = await deps.db
    .select()
    .from(messageAttachment)
    .where(eq(messageAttachment.messageId, messageId))
    .orderBy(asc(messageAttachment.position));
  return rows.map((row) => row.attachmentId);
}

describe("the Run endpoint attachments", () => {
  it("sends uploaded files with the Message and links them to it", async () => {
    const { deps, fake, conv, send, client } = await setup();
    const image = await client.attachment.upload({
      file: new File(["png-bytes"], "cat.png", { type: "image/png" }),
    });
    const notes = await client.attachment.upload({
      file: new File(["# Notes"], "notes.md", { type: "text/markdown" }),
    });

    const response = await send({ attachmentIds: [image.id, notes.id] });
    await response.text();

    expect(response.status).toBe(200);
    expect(fake.calls[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", content: `[Attachment id: ${image.id}]` },
          {
            type: "image",
            source: { type: "data", value: base64("png-bytes"), mimeType: "image/png" },
          },
          { type: "text", content: "notes.md\n```\n# Notes\n```" },
          { type: "text", content: "What is this?" },
        ],
      },
    ]);
    const [question] = await messagesOf(deps, conv.id);
    expect(await linksOf(deps, question!.id)).toEqual([image.id, notes.id]);
  });

  it("shows the attachments on the Message in conversation.get, without their bytes", async () => {
    const { conv, send, client } = await setup();
    const notes = await client.attachment.upload({
      file: new File(["# Notes"], "notes.md", { type: "text/markdown" }),
    });

    await (await send({ attachmentIds: [notes.id] })).text();

    const { messages } = await client.conversation.get({ id: conv.id });
    expect(messages[0]?.attachments).toEqual([
      { id: notes.id, filename: "notes.md", mediaType: "text/markdown", size: 7 },
    ]);
    expect(messages[1]?.attachments).toEqual([]);
  });

  it("refuses another user's attachment with 404, writing nothing", async () => {
    const { deps, conv, send } = await setup();
    const theirs = await insertAttachment(await insertUser());

    const response = await send({ attachmentIds: [theirs.id] });

    expect(response.status).toBe(404);
    expect(await messagesOf(deps, conv.id)).toEqual([]);
  });

  it("refuses a type the Model can't read with 400", async () => {
    const { user, deps, conv, send } = await setup();
    const pdf = await insertAttachment(user, {
      filename: "spec.pdf",
      mediaType: "application/pdf",
      contents: "%PDF-1.7",
    });

    const response = await send({ attachmentIds: [pdf.id], model: openaiModel });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "error.modelCantRead",
      params: { model: "GPT-5.6", kind: "pdf" },
    });
    expect(await messagesOf(deps, conv.id)).toEqual([]);
  });

  it("refuses a file over 5 MB with 400", async () => {
    const { user, send } = await setup();
    const big = await insertAttachment(user, { filename: "big.txt", size: maxAttachmentBytes + 1 });

    const response = await send({ attachmentIds: [big.id] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "error.attachmentTooLarge",
      params: { name: "big.txt" },
    });
  });

  it("refuses attachments over 20 MB on the Active Branch with 400", async () => {
    const { user, deps, conv, send } = await setup();
    const earlier = await Promise.all(
      [5, 5, 5, 4].map((size, n) =>
        insertAttachment(user, { filename: `${n}.txt`, size: size * mb }),
      ),
    );
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await linkTestAttachments(
      question.id,
      earlier.map((file) => file.id),
    );
    const reply = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Hello!",
      active: true,
    });
    const fits = await insertAttachment(user, { filename: "fits.txt", size: 1 * mb });
    const tooMuch = await insertAttachment(user, { filename: "more.txt", size: 1 * mb + 1 });

    const refused = await send({ parentId: reply.id, attachmentIds: [tooMuch.id] });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      code: "error.branchAttachmentsTooLarge",
      params: {},
    });
    expect(await messagesOf(deps, conv.id)).toHaveLength(2);

    const accepted = await send({ parentId: reply.id, attachmentIds: [fits.id] });
    await accepted.text();
    expect(accepted.status).toBe(200);
  });

  it("re-links attachments on edit, adding and removing without copying them", async () => {
    const { deps, conv, send, user } = await setup();
    const kept = await insertAttachment(user, { filename: "kept.txt" });
    const dropped = await insertAttachment(user, { filename: "dropped.txt" });
    const added = await insertAttachment(user, { filename: "added.txt" });
    await (await send({ attachmentIds: [kept.id, dropped.id] })).text();
    const [original] = await messagesOf(deps, conv.id);

    // The composer carries the edited Message's attachments over; the user removed one, added one.
    await (
      await send({ parentId: null, text: "What are these?", attachmentIds: [kept.id, added.id] })
    ).text();

    const edited = (await messagesOf(deps, conv.id)).find(
      (row) => row.searchText === "What are these?",
    );
    expect(await linksOf(deps, edited!.id)).toEqual([kept.id, added.id]);
    expect(await linksOf(deps, original!.id)).toEqual([kept.id, dropped.id]);
    expect(await deps.db.select().from(attachment)).toHaveLength(3);
  });

  it("leaves attachments alone on regenerate, sending them again", async () => {
    const { deps, fake, conv, send, user } = await setup();
    fake.calls.length = 0;
    const notes = await insertAttachment(user, { filename: "notes.txt", contents: "Hi" });
    const question = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Summarise",
    });
    await linkTestAttachments(question.id, [notes.id]);

    await (await send({ parentId: question.id, text: undefined })).text();

    expect(await deps.db.select().from(messageAttachment)).toEqual([
      { messageId: question.id, attachmentId: notes.id, position: 0 },
    ]);
    expect(fake.calls[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", content: "notes.txt\n```\nHi\n```" },
          { type: "text", content: "Summarise" },
        ],
      },
    ]);
  });

  it("refuses attachments on a regenerate with 400", async () => {
    const { conv, send, user } = await setup();
    const notes = await insertAttachment(user);
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });

    const response = await send({
      parentId: question.id,
      text: undefined,
      attachmentIds: [notes.id],
    });

    expect(response.status).toBe(400);
  });

  it("turns history attachments the Model can't read into text placeholders", async () => {
    const { fake, conv, send, user } = await setup();
    const pdf = await insertAttachment(user, {
      filename: "spec.pdf",
      mediaType: "application/pdf",
      contents: "%PDF-1.7",
    });
    const question = await insertMessage({ conversationId: conv.id, role: "user", text: "Read" });
    await linkTestAttachments(question.id, [pdf.id]);
    const reply = await insertMessage({
      conversationId: conv.id,
      parentId: question.id,
      role: "assistant",
      text: "Done.",
      active: true,
    });

    await (await send({ parentId: reply.id, text: "And now?", model: openaiModel })).text();

    expect(fake.calls[0]?.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          content: '[Attached PDF "spec.pdf" left out: this Model can\'t read PDFs]',
        },
        { type: "text", content: "Read" },
      ],
    });
  });
});
