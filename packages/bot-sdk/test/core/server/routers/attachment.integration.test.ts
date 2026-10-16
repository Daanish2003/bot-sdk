import { attachment } from "../../../../core/server/db/schema/attachment";
import { blob } from "../../../../core/server/db/schema/blob";
import { getTestDb } from "../../../support/test-database";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { attachmentBlobKey } from "../../../../core/server/blob/store";
import { maxAttachmentBytes } from "../../../../core/shared/attachments/kinds";
import {
  deleteOrphanAttachments,
  lockAttachments,
} from "../../../../core/server/attachments/store";
import { insertAttachment, linkTestAttachments } from "../../../support/attachments";
import { createTestDeps } from "../../../support/deps";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { insertUser } from "../../../support/users";
import { chatRpc } from "../../../support/sdk";

const file = (contents: string | Uint8Array<ArrayBuffer>, name: string, type: string) =>
  new File([contents], name, { type });

describe("attachment.upload", () => {
  it("stores the file and returns its id and metadata", async () => {
    const user = await insertUser();
    const client = chatRpc({ user });

    const uploaded = await client.attachment.upload({
      file: file("# Notes", "notes.md", "text/markdown"),
    });

    expect(uploaded).toEqual({
      id: expect.any(String),
      filename: "notes.md",
      mediaType: "text/markdown",
      size: 7,
    });
    const [stored] = await getTestDb()
      .select()
      .from(blob)
      .where(eq(blob.key, attachmentBlobKey(uploaded.id)));
    expect(stored?.bytes.toString("utf8")).toBe("# Notes");
  });

  it("stores a text file the browser gave no type as text/plain", async () => {
    const client = chatRpc({ user: await insertUser() });

    const uploaded = await client.attachment.upload({ file: file("fn main() {}", "main.rs", "") });

    expect(uploaded.mediaType).toBe("text/plain");
  });

  it("refuses a type that can't be attached", async () => {
    const client = chatRpc({ user: await insertUser() });

    await expect(
      client.attachment.upload({ file: file("<svg/>", "a.svg", "image/svg+xml") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("a.svg") });
  });

  it("refuses a text file that isn't UTF-8 text", async () => {
    const client = chatRpc({ user: await insertUser() });

    await expect(
      client.attachment.upload({ file: file(new Uint8Array([0xff, 0xfe, 0xfd]), "a.txt", "") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a file over 5 MB", async () => {
    const client = chatRpc({ user: await insertUser() });

    await expect(
      client.attachment.upload({
        file: file(new Uint8Array(maxAttachmentBytes + 1), "big.png", "image/png"),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("5 MB") });
  });

  it("refuses a signed-out caller", async () => {
    await expect(
      chatRpc().attachment.upload({ file: file("x", "a.txt", "text/plain") }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("deletes attachments that no Message uses after 24 hours", async () => {
    const user = await insertUser();
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const oldOrphan = await insertAttachment(user, { createdAt: longAgo });
    const freshOrphan = await insertAttachment(user);
    const oldLinked = await insertAttachment(user, { createdAt: longAgo });
    const conv = await insertConversation(user);
    const sent = await insertMessage({ conversationId: conv.id, role: "user", text: "Hi" });
    await linkTestAttachments(sent.id, [oldLinked.id]);

    const uploaded = await chatRpc({ user }).attachment.upload({
      file: file("x", "b.txt", "text/plain"),
    });

    const left = await getTestDb().select({ id: attachment.id }).from(attachment);
    expect(left.map((row) => row.id).toSorted()).toEqual(
      [freshOrphan.id, oldLinked.id, uploaded.id].toSorted(),
    );
    expect(left.map((row) => row.id)).not.toContain(oldOrphan.id);
  });

  it("leaves an old attachment alone while a send that links it holds it", async () => {
    const user = await insertUser();
    const linking = await insertAttachment(user, {
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    const db = getTestDb();
    let locked!: () => void;
    let finishSend!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const send = db.transaction(async (tx) => {
      expect(await lockAttachments(tx, user.id, [linking.id])).toBe(true);
      locked();
      await new Promise<void>((resolve) => (finishSend = resolve));
    });
    await lockTaken;

    await deleteOrphanAttachments(createTestDeps(), new Date());
    finishSend();
    await send;

    const left = await db.select({ id: attachment.id }).from(attachment);
    expect(left.map((row) => row.id)).toEqual([linking.id]);
  });
});
