import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";

import { appRouter } from "../../../../core/server/routers/index";
import { savedPrompt } from "../../../../core/server/db/schema/saved-prompt";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { createTestDeps } from "../../../support/deps";
import { getTestDb } from "../../../support/test-database";
import { chatRpc } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";

const deps = createTestDeps();

/** The router called directly with no user, so the auth middleware is what refuses. */
function signedOutRouter() {
  return createRouterClient(appRouter, { context: { user: null, deps } });
}

async function signedIn() {
  const user = await insertUser();
  return { user, client: chatRpc({ user, deps }) };
}

/** Inserts `count` Saved prompts for the user straight into the table, to reach the limit fast. */
async function seedSavedPrompts(user: TestUser, count: number) {
  const now = new Date("2026-10-01T09:00:00Z");
  await getTestDb()
    .insert(savedPrompt)
    .values(
      Array.from({ length: count }, (_, index) => ({
        id: uuidv7(),
        userId: user.id,
        name: `prompt-${index}`,
        text: "Seeded text",
        createdAt: now,
        updatedAt: now,
      })),
    );
}

/**
 * A signed-in client whose first write of `method` runs after the name check, so `clashRow` is
 * saved in the gap between the check and the write, as a concurrent request would save it.
 */
function clashingWriteClient(
  user: TestUser,
  method: "insert" | "update",
  clashRow: { userId: string; name: string },
) {
  const db = getTestDb();
  let raced = false;
  const racing = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== method) return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const write = (target[method] as (...a: unknown[]) => object)(...args);
        return lateWrite(write, async () => {
          if (raced) return;
          raced = true;
          await db.insert(savedPrompt).values({ id: uuidv7(), text: "Clashing.", ...clashRow });
        });
      };
    },
  });
  return chatRpc({ user, deps: createTestDeps({ db: racing }) });
}

/** Wraps a query builder so that awaiting it runs `beforeAwait` first. */
function lateWrite<T extends object>(builder: T, beforeAwait: () => Promise<void>): T {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === "then") {
        return (onOk: (value: unknown) => unknown, onErr: (error: unknown) => unknown) =>
          beforeAwait().then(() => (target as PromiseLike<unknown>).then(onOk, onErr));
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => lateWrite(value.apply(target, args) as object, beforeAwait);
    },
  });
}

describe("savedPrompt.list", () => {
  it("is empty by default", async () => {
    const { client } = await signedIn();

    await expect(client.savedPrompt.list()).resolves.toEqual({ items: [] });
  });

  it("lists the user's Saved prompts by name, with their text and created time", async () => {
    const { client } = await signedIn();
    await client.savedPrompt.create({ name: "review", text: "Review this code for bugs." });
    await client.savedPrompt.create({ name: "formal", text: "Rewrite this formally." });

    const { items } = await client.savedPrompt.list();

    expect(items.map((item) => item.name)).toEqual(["formal", "review"]);
    expect(items[1]).toMatchObject({ name: "review", text: "Review this code for bugs." });
    expect(items[1]!.createdAt).toBeInstanceOf(Date);
  });

  it("leaves out other users' Saved prompts", async () => {
    const { client } = await signedIn();
    const other = await signedIn();
    await other.client.savedPrompt.create({ name: "private", text: "Mine only." });

    await expect(client.savedPrompt.list()).resolves.toEqual({ items: [] });
  });

  it("rejects signed-out callers", async () => {
    await expect(signedOutRouter().savedPrompt.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("savedPrompt.create", () => {
  it("creates a Saved prompt and returns its id", async () => {
    const { client } = await signedIn();

    const { id } = await client.savedPrompt.create({ name: "standup", text: "Turn these notes." });

    const { items } = await client.savedPrompt.list();
    expect(items).toEqual([
      expect.objectContaining({ id, name: "standup", text: "Turn these notes." }),
    ]);
  });

  it("accepts lowercase letters, digits and hyphens, up to 32 characters", async () => {
    const { client } = await signedIn();

    await client.savedPrompt.create({ name: "a", text: "One letter." });
    await client.savedPrompt.create({ name: "rewrite-2-formal", text: "Digits and hyphens." });
    await client.savedPrompt.create({ name: "x".repeat(32), text: "Longest name." });

    const { items } = await client.savedPrompt.list();
    expect(items).toHaveLength(3);
  });

  it.each([
    ["an uppercase letter", "Review"],
    ["a space", "two words"],
    ["an underscore", "snake_case"],
    ["a slash", "a/b"],
    ["an empty name", ""],
    ["33 characters", "x".repeat(33)],
  ])("refuses a name with %s", async (_, name) => {
    const { client } = await signedIn();

    await expect(client.savedPrompt.create({ name, text: "Text." })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/lowercase letters, digits and -, up to 32 characters/),
    });
  });

  it.each([
    ["blank text", "   \n\t "],
    ["empty text", ""],
  ])("refuses %s", async (_, text) => {
    const { client } = await signedIn();

    await expect(client.savedPrompt.create({ name: "blank", text })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Text can't be blank",
    });
  });

  it("accepts text of exactly 10,000 characters and refuses one more", async () => {
    const { client } = await signedIn();

    await client.savedPrompt.create({ name: "longest", text: "x".repeat(10_000) });
    await expect(
      client.savedPrompt.create({ name: "too-long", text: "x".repeat(10_001) }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Text is limited to 10,000 characters",
    });
  });

  it("refuses a name the user already has, naming the clash", async () => {
    const { client } = await signedIn();
    await client.savedPrompt.create({ name: "research", text: "First." });

    await expect(
      client.savedPrompt.create({ name: "research", text: "Second." }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: 'You already have a Saved prompt named "research"',
    });
  });

  it("returns CONFLICT when a clashing name is saved between the check and the insert", async () => {
    const user = await insertUser();
    const client = clashingWriteClient(user, "insert", { userId: user.id, name: "racing" });

    await expect(
      client.savedPrompt.create({ name: "racing", text: "Second." }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: 'You already have a Saved prompt named "racing"',
    });
  });

  it("lets another user have the same name", async () => {
    const { client } = await signedIn();
    const other = await signedIn();
    await client.savedPrompt.create({ name: "research", text: "Mine." });

    await expect(
      other.client.savedPrompt.create({ name: "research", text: "Theirs." }),
    ).resolves.toEqual({ id: expect.any(String) });
  });

  it("allows 100 Saved prompts and refuses the 101st", async () => {
    const { user, client } = await signedIn();
    await seedSavedPrompts(user, 99);
    await client.savedPrompt.create({ name: "hundredth", text: "Last one allowed." });

    await expect(
      client.savedPrompt.create({ name: "one-more", text: "Too many." }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You have 100 Saved prompts. Delete one first.",
    });
    expect((await client.savedPrompt.list()).items).toHaveLength(100);
  });

  it("rejects signed-out callers", async () => {
    await expect(
      signedOutRouter().savedPrompt.create({ name: "nope", text: "Nope." }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("savedPrompt.update", () => {
  it("changes the name and text and keeps the created time", async () => {
    const { client } = await signedIn();
    const { id } = await client.savedPrompt.create({ name: "draft", text: "Old text." });
    const before = (await client.savedPrompt.list()).items[0]!;

    await client.savedPrompt.update({ id, name: "draft-2", text: "New text." });

    const { items } = await client.savedPrompt.list();
    expect(items).toEqual([
      expect.objectContaining({
        id,
        name: "draft-2",
        text: "New text.",
        createdAt: before.createdAt,
      }),
    ]);
  });

  it("returns CONFLICT when a clashing name is saved between the check and the update", async () => {
    const user = await insertUser();
    const client = clashingWriteClient(user, "update", { userId: user.id, name: "racing" });
    const { id } = await client.savedPrompt.create({ name: "free", text: "First." });

    await expect(
      client.savedPrompt.update({ id, name: "racing", text: "Second." }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: 'You already have a Saved prompt named "racing"',
    });
  });

  it("keeps the user's own name without a clash", async () => {
    const { client } = await signedIn();
    const { id } = await client.savedPrompt.create({ name: "same", text: "Old." });

    await expect(
      client.savedPrompt.update({ id, name: "same", text: "New." }),
    ).resolves.toBeUndefined();
  });

  it("refuses a name another of the user's Saved prompts has, naming the clash", async () => {
    const { client } = await signedIn();
    await client.savedPrompt.create({ name: "taken", text: "First." });
    const { id } = await client.savedPrompt.create({ name: "free", text: "Second." });

    await expect(
      client.savedPrompt.update({ id, name: "taken", text: "Second." }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: 'You already have a Saved prompt named "taken"',
    });
  });

  it("applies the same validation as create", async () => {
    const { client } = await signedIn();
    const { id } = await client.savedPrompt.create({ name: "valid", text: "Text." });

    await expect(
      client.savedPrompt.update({ id, name: "Bad Name", text: "Text." }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      client.savedPrompt.update({ id, name: "valid", text: "  " }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Text can't be blank",
    });
  });

  it("is owner only: another user's or an unknown Saved prompt is NOT_FOUND", async () => {
    const { client } = await signedIn();
    const other = await signedIn();
    const { id } = await client.savedPrompt.create({ name: "mine", text: "Mine." });

    await expect(
      other.client.savedPrompt.update({ id, name: "stolen", text: "Stolen." }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      client.savedPrompt.update({ id: uuidv7(), name: "ghost", text: "None." }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.savedPrompt.list()).resolves.toMatchObject({
      items: [expect.objectContaining({ name: "mine", text: "Mine." })],
    });
  });

  it("rejects signed-out callers", async () => {
    await expect(
      signedOutRouter().savedPrompt.update({ id: uuidv7(), name: "nope", text: "Nope." }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("savedPrompt.delete", () => {
  it("deletes the Saved prompt", async () => {
    const { client } = await signedIn();
    const { id } = await client.savedPrompt.create({ name: "gone", text: "Bye." });

    await client.savedPrompt.delete({ id });

    await expect(client.savedPrompt.list()).resolves.toEqual({ items: [] });
  });

  it("is owner only: another user's or an unknown Saved prompt is NOT_FOUND and stays", async () => {
    const { client } = await signedIn();
    const other = await signedIn();
    const { id } = await client.savedPrompt.create({ name: "kept", text: "Kept." });

    await expect(other.client.savedPrompt.delete({ id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.savedPrompt.delete({ id: uuidv7() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.savedPrompt.list()).resolves.toMatchObject({
      items: [expect.objectContaining({ name: "kept" })],
    });
  });

  it("frees the name for reuse", async () => {
    const { client } = await signedIn();
    const { id } = await client.savedPrompt.create({ name: "reuse", text: "First." });
    await client.savedPrompt.delete({ id });

    await expect(client.savedPrompt.create({ name: "reuse", text: "Second." })).resolves.toEqual({
      id: expect.any(String),
    });
  });

  it("rejects signed-out callers", async () => {
    await expect(signedOutRouter().savedPrompt.delete({ id: uuidv7() })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
