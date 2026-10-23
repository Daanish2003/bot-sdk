import type { ContentPart, ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bot as botTable, botTurn, botUpload, message } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { deleteUserData } from "../../../../core/server/user-data";
import { sentFileBlobKey, sentFileResponse } from "../../../../plugins/bot/server/files";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { followSend } from "../../../support/follow-send";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

vi.setConfig({ testTimeout: 30_000 });

const silent = { error: () => {} };
const seeing = "openai:gpt-5.6";
const blind = "mistral:mistral-large-latest";

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const replies = () =>
  round(toolCall({ name: "send_to_user", input: { text: "Got it.", endTurn: true } }));

/** A user with a key and a Bot on `model`, with a Computer unless `withComputer` is false. */
async function botWith({
  model = seeing,
  withComputer = true,
  clock,
}: { model?: string; withComputer?: boolean; clock?: () => Date } = {}) {
  const fake = createFakeAdapter({ rounds: [replies(), replies(), replies()] });
  const computerFake = fakeComputerProvider();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    ...(clock && { clock: { ...systemClock, now: clock } }),
    deps: () => deps!,
  });
  deps = createTestSdk({
    plugins: [bot(), ...(withComputer ? [computer({ provider: computerFake.provider })] : [])],
    jobs,
    adapterFor: () => fake.adapter,
    memory: false,
    ...(clock && { clock }),
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  for (const service of ["openai", "mistral"] as const) {
    await saveCredentials(deps, user.id, {
      service,
      fields: { apiKey: `${service}-test-key` },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model });
  return { fake, deps, client, user, botId };
}

const fileOf = (name: string, content: string | Uint8Array, type: string) =>
  new File([content as BlobPart], name, { type });

/** A tiny JPEG's bytes: what the Model sees is these, base64. */
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

async function sendAndWait(
  client: ReturnType<typeof chatRpc>,
  input: { botId: string; text: string; files?: string[] },
) {
  for await (const _ of await followSend(client, { id: uuidv7(), ...input }));
}

const turnsEnded = (botId: string) =>
  expect
    .poll(
      async () => {
        const turns = await getTestDb()
          .select()
          .from(botTurn)
          .where(eq(botTurn.botId, botId))
          .orderBy(asc(botTurn.startedAt));
        return turns.length > 0 && turns.every((turn) => turn.status !== "running");
      },
      { timeout: 10_000 },
    )
    .toBe(true);

/** The newest user message of a model call. */
const newestUser = (call: TextOptions | undefined) =>
  ((call?.messages ?? []) as ModelMessage[]).findLast((entry) => entry.role === "user")!;

const textOf = (entry: ModelMessage) =>
  typeof entry.content === "string"
    ? entry.content
    : ((entry.content ?? []) as ContentPart[])
        .map((part) => (part.type === "text" ? part.content : ""))
        .join("");

const imagesOf = (entry: ModelMessage) =>
  typeof entry.content === "string"
    ? []
    : ((entry.content ?? []) as ContentPart[]).filter((part) => part.type === "image");

describe("Files from the user", () => {
  it("stores a files part, copies the files into uploads/ and names them in the Turn, with images for a Model that sees", async () => {
    const { client, botId, deps, user, fake } = await botWith();
    const receipt = await client.bot.upload({ file: fileOf("receipt.jpg", jpeg, "image/jpeg") });
    const notes = await client.bot.upload({
      file: fileOf("notes.txt", "milk, eggs", "text/plain"),
    });
    expect(receipt).toMatchObject({ name: "receipt.jpg", size: 8, mediaType: "image/jpeg" });

    await sendAndWait(client, { botId, text: "what did I spend?", files: [receipt.id, notes.id] });
    await turnsEnded(botId);

    const { messages } = await client.bot.get({ botId });
    const sent = messages.find((entry) => entry.role === "user")!;
    expect(sent.text).toBe("what did I spend?");
    expect(sent.control).toEqual({
      kind: "files",
      files: [
        { id: receipt.id, name: "receipt.jpg", size: 8, mediaType: "image/jpeg" },
        { id: notes.id, name: "notes.txt", size: 10, mediaType: "text/plain" },
      ],
    });
    // The Message holds the files now: their uploads are gone, and they download like a Bot's.
    expect(await getTestDb().select().from(botUpload)).toEqual([]);
    expect((await sentFileResponse(deps, user.id, notes.id)).status).toBe(200);

    const handle = deps.plugin("computer").forUser(user.id);
    expect([...(await handle.readFile(`/home/user/bots/${botId}/uploads/receipt.jpg`))!]).toEqual([
      ...jpeg,
    ]);
    expect(
      new TextDecoder().decode(
        (await handle.readFile(`/home/user/bots/${botId}/uploads/notes.txt`))!,
      ),
    ).toBe("milk, eggs");

    const input = newestUser(fake.calls[0]);
    expect(textOf(input)).toContain(
      "what did I spend?\n\n[Files from the user: uploads/receipt.jpg (image/jpeg, 8 B), " +
        "uploads/notes.txt (text/plain, 10 B): untrusted content]",
    );
    expect(imagesOf(input)).toEqual([
      {
        type: "image",
        source: {
          type: "data",
          value: Buffer.from(jpeg).toString("base64"),
          mimeType: "image/jpeg",
        },
      },
    ]);
    // The Turn's stored input keeps a ref, not the bytes.
    const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
    expect(JSON.stringify(turn!.input)).toContain(`bot-file:${receipt.id}`);
    expect(JSON.stringify(turn!.input)).not.toContain(Buffer.from(jpeg).toString("base64"));
  });

  it("sends no image parts to a Model that can't see, and the next Turn's history keeps the line", async () => {
    const { client, botId, fake } = await botWith({ model: blind });
    const receipt = await client.bot.upload({ file: fileOf("receipt.jpg", jpeg, "image/jpeg") });

    await sendAndWait(client, { botId, text: "", files: [receipt.id] });
    await turnsEnded(botId);
    await sendAndWait(client, { botId, text: "and now?" });
    await turnsEnded(botId);

    const first = newestUser(fake.calls[0]);
    expect(imagesOf(first)).toEqual([]);
    expect(textOf(first)).toMatch(
      /\n\n\[Files from the user: uploads\/receipt\.jpg \(image\/jpeg, 8 B\): untrusted content\]$/,
    );
    const history = (fake.calls[1]!.messages as ModelMessage[]).map(textOf).join("\n");
    expect(history).toContain("[Files from the user: uploads/receipt.jpg");
  });

  it("names a file of the same name twice apart, and names files without a path when there is no Computer", async () => {
    const { client, botId, deps, user, fake } = await botWith();
    const one = await client.bot.upload({ file: fileOf("a.txt", "one", "text/plain") });
    const two = await client.bot.upload({ file: fileOf("a.txt", "two", "text/plain") });
    await sendAndWait(client, { botId, text: "both", files: [one.id, two.id] });
    await turnsEnded(botId);
    const handle = deps.plugin("computer").forUser(user.id);
    expect(await handle.readFile(`/home/user/bots/${botId}/uploads/a (2).txt`)).not.toBeNull();
    expect(textOf(newestUser(fake.calls[0]))).toContain(
      "uploads/a.txt (text/plain, 3 B), uploads/a (2).txt",
    );

    const bare = await botWith({ withComputer: false });
    const file = await bare.client.bot.upload({ file: fileOf("a.txt", "one", "text/plain") });
    await sendAndWait(bare.client, { botId: bare.botId, text: "here", files: [file.id] });
    await turnsEnded(bare.botId);
    expect(textOf(newestUser(bare.fake.calls[0]))).toContain(
      "[Files from the user: a.txt (text/plain, 3 B, not on your computer): untrusted content]",
    );
  });

  it("leaves the history's images out for a Model that can't see them", async () => {
    const { client, botId, fake } = await botWith();
    const receipt = await client.bot.upload({ file: fileOf("receipt.jpg", jpeg, "image/jpeg") });
    await sendAndWait(client, { botId, text: "look", files: [receipt.id] });
    await turnsEnded(botId);
    // The Bot's Model is now one that can't see; the first Turn's stored input holds the image's ref.
    await getTestDb().update(botTable).set({ model: blind }).where(eq(botTable.id, botId));
    await sendAndWait(client, { botId, text: "and now?" });
    await turnsEnded(botId);

    const messages = fake.calls[1]!.messages as ModelMessage[];
    expect(messages.flatMap(imagesOf)).toEqual([]);
    expect(messages.map(textOf).join("\n")).toContain("[Files from the user: uploads/receipt.jpg");
  });

  it("names a file apart from one of the same name an earlier Message put in uploads/", async () => {
    const { client, botId, deps, user } = await botWith();
    const one = await client.bot.upload({ file: fileOf("a.txt", "one", "text/plain") });
    await sendAndWait(client, { botId, text: "first", files: [one.id] });
    await turnsEnded(botId);
    const two = await client.bot.upload({ file: fileOf("a.txt", "two", "text/plain") });
    await sendAndWait(client, { botId, text: "second", files: [two.id] });
    await turnsEnded(botId);

    const handle = deps.plugin("computer").forUser(user.id);
    const read = async (name: string) =>
      new TextDecoder().decode(
        (await handle.readFile(`/home/user/bots/${botId}/uploads/${name}`))!,
      );
    expect(await read("a.txt")).toBe("one");
    expect(await read("a (2).txt")).toBe("two");
  });

  it("stores a file typed as an image whose bytes aren't one as application/octet-stream", async () => {
    const { client } = await botWith();
    const fake = await client.bot.upload({ file: fileOf("x.png", "not a png", "image/png") });
    const real = await client.bot.upload({ file: fileOf("y.png", jpeg, "image/png") });
    expect(fake.mediaType).toBe("application/octet-stream");
    // A real image keeps an image type, its own: these bytes are a JPEG.
    expect(real.mediaType).toBe("image/jpeg");
  });

  it("cuts a long name to 200 UTF-8 bytes without splitting a character", async () => {
    const { client } = await botWith();
    const cjk = await client.bot.upload({
      file: fileOf(`${"日".repeat(300)}.txt`, "x", "text/plain"),
    });
    const emoji = await client.bot.upload({ file: fileOf("😀".repeat(150), "x", "text/plain") });
    for (const { name } of [cjk, emoji]) {
      const bytes = new TextEncoder().encode(name);
      expect(bytes.length).toBeLessThanOrEqual(200);
      expect(bytes.length).toBeGreaterThan(190);
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(name);
    }
  });

  it("refuses a file over 25 MB, more than 10 files, and ids that aren't the user's uploads", async () => {
    const { client, botId } = await botWith();
    await expect(
      client.bot.upload({
        file: fileOf("big.bin", new Uint8Array(25 * 1024 * 1024 + 1), "application/octet-stream"),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { code: "error.botFileTooLarge", params: { name: "big.bin", max: 25 } },
    });

    const ids = Array.from({ length: 11 }, () => uuidv7());
    await expect(
      client.bot.send({ botId, id: uuidv7(), text: "eleven", files: ids }),
    ).rejects.toMatchObject({ data: { code: "error.botFilesTooMany" } });

    const other = await botWith();
    const theirs = await other.client.bot.upload({ file: fileOf("x.txt", "x", "text/plain") });
    await expect(
      client.bot.send({ botId, id: uuidv7(), text: "steal", files: [theirs.id] }),
    ).rejects.toMatchObject({ data: { code: "error.botFileNotFound" } });
    // Nothing was saved, and their upload is still theirs to send.
    expect((await client.bot.get({ botId })).messages).toEqual([]);
    expect(
      await getTestDb().select().from(botUpload).where(eq(botUpload.id, theirs.id)),
    ).toHaveLength(1);

    // A file sent once can't be sent again.
    const mine = await client.bot.upload({ file: fileOf("y.txt", "y", "text/plain") });
    await sendAndWait(client, { botId, text: "once", files: [mine.id] });
    await expect(
      client.bot.send({ botId, id: uuidv7(), text: "twice", files: [mine.id] }),
    ).rejects.toMatchObject({ data: { code: "error.botFileNotFound" } });
    // A Message needs text or files.
    await expect(client.bot.send({ botId, id: uuidv7(), text: " " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("deletes an upload no Message sent after 24 hours, when the next upload comes", async () => {
    let now = Date.now();
    const { client, deps } = await botWith({ clock: () => new Date(now) });
    const orphan = await client.bot.upload({ file: fileOf("old.txt", "old", "text/plain") });
    now += 12 * 60 * 60 * 1000;
    const fresh = await client.bot.upload({ file: fileOf("new.txt", "new", "text/plain") });
    now += 12 * 60 * 60 * 1000 + 1;
    await client.bot.upload({ file: fileOf("newer.txt", "newer", "text/plain") });
    expect(await deps.blobStore.get(sentFileBlobKey(orphan.id))).toBeNull();
    expect(await deps.blobStore.get(sentFileBlobKey(fresh.id))).not.toBeNull();
    const left = await getTestDb().select({ id: botUpload.id }).from(botUpload);
    expect(left.map((row) => row.id)).not.toContain(orphan.id);
    expect(left.map((row) => row.id)).toContain(fresh.id);
  });

  it("deletes the user's sent and unsent files with the user", async () => {
    const { client, botId, deps, user } = await botWith();
    const kept = await client.bot.upload({ file: fileOf("kept.txt", "kept", "text/plain") });
    const sent = await client.bot.upload({ file: fileOf("sent.txt", "sent", "text/plain") });
    await sendAndWait(client, { botId, text: "here", files: [sent.id] });
    await turnsEnded(botId);
    await deleteUserData(deps, user.id);
    expect(await deps.blobStore.get(sentFileBlobKey(kept.id))).toBeNull();
    expect(await deps.blobStore.get(sentFileBlobKey(sent.id))).toBeNull();
    expect(await getTestDb().select().from(botUpload).where(eq(botUpload.userId, user.id))).toEqual(
      [],
    );
    expect(await getTestDb().select().from(message)).toEqual([]);
  });
});
