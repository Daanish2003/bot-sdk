import { describe, expect, it } from "vitest";

import { bot, botTurn } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { insertConversation } from "../../../support/conversations";
import { getTestDb } from "../../../support/test-database";

import { knowledge } from "../../../../plugins/knowledge/server/plugin";
import { createTestSdk } from "../../../support/deps";
import { chatRpc } from "../../../support/sdk";
import { insertOwner } from "../../../support/users";
import { fakeComputerProvider } from "../../../support/fake-computer-provider";

const folder = "/home/user/shared/knowledge";
const limit = 50 * 1024 * 1024;
const encode = (text: string) => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
const knowledgePaths = (files: Map<string, Uint8Array>) =>
  [...files.keys()].filter((path) => path.startsWith(`${folder}/`)).toSorted();

async function setup({ withComputer = true }: { withComputer?: boolean } = {}) {
  const computerFake = fakeComputerProvider();
  const deps = createTestSdk({
    ...(withComputer && { computer: computerFake.provider }),
    features: [knowledge()],
  });
  const user = await insertOwner();
  const client = chatRpc({ user, deps });
  return { computerFake, client, deps, user };
}

describe("the knowledge router", { timeout: 30_000 }, () => {
  it.each([
    ["handbook.md", "# Handbook\n"],
    ["notes.txt", "Plain notes.\n"],
    ["page.html", "<p>Hello</p>"],
    ["prices.csv", "item,price\ntea,3\n"],
  ])("uploads %s under shared/knowledge/", async (name, content) => {
    const { computerFake, client } = await setup();

    expect(await client.knowledge.upload({ name, content })).toEqual({
      path: name,
      size: encode(content).length,
    });

    expect(textOf(computerFake.files.get(`${folder}/${name}`))).toBe(content);
  });

  it("uploads into a chosen folder", async () => {
    const { computerFake, client } = await setup();

    await client.knowledge.upload({ folder: "clients/acme", name: "notes.md", content: "Hi" });

    expect(textOf(computerFake.files.get(`${folder}/clients/acme/notes.md`))).toBe("Hi");
  });

  it("refuses an unsupported format and writes nothing", async () => {
    const { computerFake, client } = await setup();

    for (const name of ["photo.png", "archive.zip", "noextension", "handbook.md.exe"]) {
      await expect(client.knowledge.upload({ name, content: "x" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { code: "error.knowledgeFormat" },
      });
    }
    expect(computerFake.files.size).toBe(0);
  });

  it("refuses a name or folder that leaves the Knowledge folder", async () => {
    const { computerFake, client } = await setup();

    for (const input of [
      { name: "../escape.md" },
      { name: "a/b.md" },
      { folder: "../up", name: "x.md" },
      { folder: "a//b", name: "x.md" },
      { folder: "/etc", name: "x.md" },
    ]) {
      await expect(client.knowledge.upload({ content: "x", ...input })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        data: { code: "error.knowledgePath" },
      });
    }
    expect(computerFake.files.size).toBe(0);
  });

  it("refuses an upload that would take Knowledge past 50 MB, and writes nothing", async () => {
    const { computerFake, client } = await setup();
    computerFake.files.set(`${folder}/big.txt`, new Uint8Array(limit - 10));

    await expect(
      client.knowledge.upload({ name: "more.md", content: "x".repeat(11) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code: "error.knowledgeFull" } });
    expect(knowledgePaths(computerFake.files)).toEqual([`${folder}/big.txt`]);

    // Exactly 50 MB fits.
    expect(await client.knowledge.upload({ name: "fits.md", content: "x".repeat(10) })).toEqual({
      path: "fits.md",
      size: 10,
    });
  });

  it("refuses the same name in the same folder unless replace is set", async () => {
    const { computerFake, client } = await setup();
    await client.knowledge.upload({ folder: "a", name: "x.md", content: "old" });

    await expect(
      client.knowledge.upload({ folder: "a", name: "x.md", content: "new" }),
    ).rejects.toMatchObject({ code: "CONFLICT", data: { code: "error.knowledgeExists" } });
    expect(textOf(computerFake.files.get(`${folder}/a/x.md`))).toBe("old");

    // Another folder is another file.
    await client.knowledge.upload({ folder: "b", name: "x.md", content: "other" });

    await client.knowledge.upload({
      folder: "a",
      name: "x.md",
      content: "new",
      replace: true,
    });
    expect(textOf(computerFake.files.get(`${folder}/a/x.md`))).toBe("new");
  });

  it("counts a replaced file's old size out of the cap", async () => {
    const { computerFake, client } = await setup();
    computerFake.files.set(`${folder}/big.txt`, new Uint8Array(limit));

    await client.knowledge.upload({ name: "big.txt", content: "small", replace: true });

    expect(textOf(computerFake.files.get(`${folder}/big.txt`))).toBe("small");
  });

  it("deletes a file, and refuses one that is not there", async () => {
    const { computerFake, client } = await setup();
    await client.knowledge.upload({ folder: "a", name: "x.md", content: "x" });
    await client.knowledge.upload({ name: "keep.md", content: "keep" });

    await client.knowledge.remove({ path: "a/x.md" });

    expect(knowledgePaths(computerFake.files)).toEqual([`${folder}/keep.md`]);
    await expect(client.knowledge.remove({ path: "a/x.md" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.knowledge.remove({ path: "../x.md" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("creates a folder on the Computer", async () => {
    const { computerFake, client } = await setup();

    await client.knowledge.createFolder({ path: "clients/acme" });

    expect(computerFake.callsOf("run").map((call) => call.command)).toContain(
      `mkdir -p '${folder}/clients/acme'`,
    );
    await expect(client.knowledge.createFolder({ path: "../up" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("lists the tree with sizes, usage, and who saved each file", async () => {
    const { computerFake, client } = await setup();
    await client.knowledge.upload({ name: "handbook.md", content: "# Handbook" });
    await client.knowledge.upload({ folder: "clients", name: "acme.txt", content: "Acme" });
    // Files a Bot wrote with its own tools.
    computerFake.files.set(`${folder}/clients/report.md`, encode("Report text"));
    computerFake.files.set(`${folder}/deep/er/note.md`, encode("n"));

    const listed = await client.knowledge.list();

    expect(listed.files).toEqual([
      { path: "clients/acme.txt", size: 4, savedBy: "user" },
      { path: "clients/report.md", size: 11, savedBy: "bot" },
      { path: "deep/er/note.md", size: 1, savedBy: "bot" },
      { path: "handbook.md", size: 10, savedBy: "user" },
    ]);
    expect(listed.folders).toEqual(["clients", "deep", "deep/er"]);
    expect(listed.usage).toBe(26);
    expect(listed.limit).toBe(limit);
  });

  it('names the Bot whose recorded Turn saved a file, and says "a Bot" otherwise', async () => {
    const { computerFake, client, user } = await setup();
    const conversation = await insertConversation(user, { kind: "bot" });
    const botId = uuidv7();
    await getTestDb().insert(bot).values({
      id: botId,
      userId: user.id,
      conversationId: conversation.id,
      name: "Ada",
      model: "x:y",
    });
    await getTestDb()
      .insert(botTurn)
      .values({
        id: uuidv7(),
        botId,
        status: "complete",
        startedAt: new Date(),
        knowledgeChanges: [{ botId, path: "clients/report.md" }],
      });
    computerFake.files.set(`${folder}/clients/report.md`, encode("Report text"));
    computerFake.files.set(`${folder}/other.md`, encode("x"));
    await client.knowledge.upload({ name: "mine.md", content: "m" });

    expect((await client.knowledge.list()).files).toEqual([
      { path: "clients/report.md", size: 11, savedBy: "bot", botName: "Ada" },
      { path: "mine.md", size: 1, savedBy: "user" },
      { path: "other.md", size: 1, savedBy: "bot" },
    ]);
  });

  it("lists nothing for a Computer with no Knowledge yet", async () => {
    const { client } = await setup();

    expect(await client.knowledge.list()).toEqual({
      files: [],
      folders: [],
      usage: 0,
      limit,
    });
  });

  it("stops listing a deleted upload as the user's when a Bot writes the name again", async () => {
    const { computerFake, client } = await setup();
    await client.knowledge.upload({ name: "x.md", content: "x" });
    await client.knowledge.remove({ path: "x.md" });
    computerFake.files.set(`${folder}/x.md`, encode("by a Bot"));

    expect((await client.knowledge.list()).files).toEqual([
      { path: "x.md", size: 8, savedBy: "bot" },
    ]);
  });

  it("keeps every upload of a concurrent batch as the user's", async () => {
    const { client } = await setup();
    const names = ["a.md", "b.md", "c.md", "d.md", "e.md"];

    await Promise.all(names.map((name) => client.knowledge.upload({ name, content: name })));

    expect((await client.knowledge.list()).files).toEqual(
      names.map((name) => ({ path: name, size: 4, savedBy: "user" })),
    );
  });

  it("never takes Knowledge past 50 MB with concurrent uploads", async () => {
    const { computerFake, client } = await setup();
    computerFake.files.set(`${folder}/big.txt`, new Uint8Array(limit - 10));

    const results = await Promise.allSettled(
      ["one.md", "two.md"].map((name) => client.knowledge.upload({ name, content: "x".repeat(6) })),
    );

    expect(results.map((result) => result.status).toSorted()).toEqual(["fulfilled", "rejected"]);
    expect(knowledgePaths(computerFake.files)).toHaveLength(2);
  });

  it("lists a user's upload as a Bot's once a Bot's recorded Turn rewrote it", async () => {
    const { computerFake, client, user } = await setup();
    await client.knowledge.upload({ name: "report.md", content: "mine" });
    const conversation = await insertConversation(user, { kind: "bot" });
    const botId = uuidv7();
    await getTestDb().insert(bot).values({
      id: botId,
      userId: user.id,
      conversationId: conversation.id,
      name: "Ada",
      model: "x:y",
    });
    // A Turn that only read the file leaves it the user's.
    expect((await client.knowledge.list()).files).toEqual([
      { path: "report.md", size: 4, savedBy: "user" },
    ]);
    computerFake.files.set(`${folder}/report.md`, encode("Ada's"));
    await getTestDb()
      .insert(botTurn)
      .values({
        id: uuidv7(),
        botId,
        status: "complete",
        startedAt: new Date(),
        knowledgeChanges: [{ botId, path: "report.md" }],
      });

    expect((await client.knowledge.list()).files).toEqual([
      { path: "report.md", size: 5, savedBy: "bot", botName: "Ada" },
    ]);
  });

  it("lists an upload as a Bot's once its shell rewrote it, with no list in between", async () => {
    const { computerFake, client } = await setup();
    await client.knowledge.upload({ name: "x.md", content: "x" });
    // `rm x.md && echo y > x.md` in one shell call: nothing is recorded.
    computerFake.files.delete(`${folder}/x.md`);
    computerFake.files.set(`${folder}/x.md`, encode("y"));

    expect((await client.knowledge.list()).files).toEqual([
      { path: "x.md", size: 1, savedBy: "bot" },
    ]);
  });

  it("refuses an upload over a name that a long listing leaves out", async () => {
    const { computerFake, client } = await setup();
    // About 1.4 MB of listing, past the 1 MB a walk reads; the last file is past the cut.
    for (let index = 0; index < 30_000; index++) {
      computerFake.files.set(
        `${folder}/many/${String(index).padStart(5, "0")}-${"x".repeat(30)}.md`,
        encode("x"),
      );
    }
    computerFake.files.set(`${folder}/many/last.md`, encode("old"));

    await expect(
      client.knowledge.upload({ folder: "many", name: "last.md", content: "new" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(textOf(computerFake.files.get(`${folder}/many/last.md`))).toBe("old");
  });

  it("forgets an upload that a Bot removed, so a file a Bot writes there later is the Bot's", async () => {
    const { computerFake, client } = await setup();
    await client.knowledge.upload({ name: "x.md", content: "x" });
    // A Bot's `rm`, seen by a list, then a Bot's shell write of the same name.
    computerFake.files.delete(`${folder}/x.md`);
    expect((await client.knowledge.list()).files).toEqual([]);
    computerFake.files.set(`${folder}/x.md`, encode("by a Bot"));

    expect((await client.knowledge.list()).files).toEqual([
      { path: "x.md", size: 8, savedBy: "bot" },
    ]);
  });

  it("walks the tree in one command, not one list per folder", async () => {
    const { computerFake, client } = await setup();
    computerFake.files.set(`${folder}/a/b/c/note.md`, encode("n"));

    expect((await client.knowledge.list()).folders).toEqual(["a", "a/b", "a/b/c"]);
    expect(computerFake.callsOf("run")).toHaveLength(1);
  });

  it("reads a file's text", async () => {
    const { client } = await setup();
    await client.knowledge.upload({ folder: "a", name: "x.md", content: "# Hi\n" });

    expect(await client.knowledge.read({ path: "a/x.md" })).toEqual({
      path: "a/x.md",
      content: "# Hi\n",
      size: 5,
    });
    await expect(client.knowledge.read({ path: "a/none.md" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("is a configuration error without the computer plugin", async () => {
    await expect(setup({ withComputer: false })).rejects.toThrow(/computer/);
  });

  it("is available with the computer plugin, whatever the Memory switch says", async () => {
    const { client } = await setup();

    expect(await client.knowledge.status()).toEqual({ available: true });
  });

  it("keeps one user's Knowledge from another", async () => {
    const { deps } = await setup();
    const alice = chatRpc({ user: await insertOwner(), deps });
    const bob = chatRpc({ user: await insertOwner(), deps });
    await alice.knowledge.upload({ name: "secret.md", content: "alice" });

    expect((await bob.knowledge.list()).files).toEqual([]);
  });
});
