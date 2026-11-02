import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { createBotSdk, postgres } from "@botsdk/bot";
import { featureApi } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { bot } from "@botsdk/bot/storage";
import { deleteUserData, exportUserData } from "@botsdk/bot/user-data";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { insertConversation } from "@ai-chat/test-support/conversations";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb, testDatabaseUrl } from "@ai-chat/test-support/test-database";
import { insertUser, type TestUser } from "@ai-chat/test-support/users";
import { representative, type RepresentativeApi } from "../src";
import {
  representative as representativeTable,
  representativeRelease,
} from "../src/server/db/schema";

vi.setConfig({ testTimeout: 30_000 });

/** An owner with the feature on, and the signed-in RPC client over it. */
async function owner() {
  const deps = createTestSdk({ features: [representative()] });
  const user = await insertUser();
  return { deps, user, rpc: chatRpc({ user, deps }) };
}

/** A second signed-in user on the same instance. */
async function another(deps: Awaited<ReturnType<typeof owner>>["deps"]) {
  const user = await insertUser();
  return { user, rpc: chatRpc({ user, deps }) };
}

async function insertBot(user: TestUser, name = "Ada") {
  const conversation = await insertConversation(user, { kind: "bot" });
  const id = uuidv7();
  await getTestDb().insert(bot).values({
    id,
    userId: user.id,
    conversationId: conversation.id,
    name,
    model: "openai:gpt-6-luna",
  });
  return id;
}

const releaseRows = (representativeId: string) =>
  getTestDb()
    .select()
    .from(representativeRelease)
    .where(eq(representativeRelease.representativeId, representativeId))
    .orderBy(representativeRelease.number);

describe("creating and editing a Representative", () => {
  it("creates one with an empty draft, no Release and off, and lists it for its owner only", async () => {
    const { deps, rpc } = await owner();
    const created = await rpc.representative.create({ name: "Front desk" });

    expect(created).toMatchObject({
      name: "Front desk",
      botId: null,
      enabled: false,
      liveReleaseNumber: null,
      liveRelease: null,
      releases: [],
      draft: {
        jobText: "",
        switches: {},
        skills: [],
        tools: ["reply", "hand_to_bot"],
        model: null,
      },
    });
    expect(await rpc.representative.list()).toEqual([
      { id: created.id, name: "Front desk", botId: null, enabled: false, liveReleaseNumber: null },
    ]);
    expect(await (await another(deps)).rpc.representative.list()).toEqual([]);
  });

  it("changes the fields it is given and keeps the rest", async () => {
    const { rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });

    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer pricing questions" } });
    const updated = await rpc.representative.updateDraft({
      id,
      draft: { tools: ["reply"], model: "openai:gpt-6-luna" },
    });

    expect(updated.draft).toEqual({
      jobText: "Answer pricing questions",
      switches: {},
      skills: [],
      tools: ["reply"],
      model: "openai:gpt-6-luna",
      tests: [],
    });
  });

  it("refuses a draft that names a tool outside the code-defined list, through the API and the SDK", async () => {
    const { deps, user, rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });

    await expect(
      // @ts-expect-error `bash` isn't a tool a Representative can have
      rpc.representative.updateDraft({ id, draft: { tools: ["reply", "bash"] } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      featureApi<RepresentativeApi>(deps, "representative").updateDraft({
        userId: user.id,
        id,
        // @ts-expect-error `bash` isn't a tool a Representative can have
        draft: { tools: ["bash"] },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rpc.representative.get({ id })).draft.tools).toEqual(["reply", "hand_to_bot"]);
  });

  it("can't be read or changed by another owner", async () => {
    const { deps, rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });
    const { rpc: stranger } = await another(deps);
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer" } });

    const notFound = { code: "NOT_FOUND", data: { code: "error.representativeNotFound" } };
    await expect(stranger.representative.get({ id })).rejects.toMatchObject(notFound);
    await expect(
      stranger.representative.updateDraft({ id, draft: { jobText: "Hijacked" } }),
    ).rejects.toMatchObject(notFound);
    await expect(stranger.representative.approve({ id })).rejects.toMatchObject(notFound);
    await expect(stranger.representative.setEnabled({ id, enabled: true })).rejects.toMatchObject(
      notFound,
    );
    expect(await rpc.representative.get({ id })).toMatchObject({
      enabled: false,
      draft: { jobText: "Answer" },
      releases: [],
    });
  });
});

describe("the Bot a Representative reports to", () => {
  it("reports to one of the owner's Bots, and one Bot can have several Representatives", async () => {
    const { user, rpc } = await owner();
    const botId = await insertBot(user);

    const first = await rpc.representative.create({ name: "Sales", botId });
    const second = await rpc.representative.create({ name: "Support", botId });

    expect([first.botId, second.botId]).toEqual([botId, botId]);
    expect((await rpc.representative.list()).map((item) => item.botId)).toEqual([botId, botId]);
  });

  it("refuses a Bot that isn't the owner's, or doesn't exist", async () => {
    const { deps, rpc } = await owner();
    const { user: other } = await another(deps);
    const othersBot = await insertBot(other, "Grace");

    const refused = { code: "NOT_FOUND", data: { code: "error.botNotFound" } };
    await expect(
      rpc.representative.create({ name: "Sales", botId: othersBot }),
    ).rejects.toMatchObject(refused);
    await expect(
      rpc.representative.create({ name: "Sales", botId: uuidv7() }),
    ).rejects.toMatchObject(refused);
    expect(await rpc.representative.list()).toEqual([]);
  });
});

describe("approving a draft into a Release", () => {
  it("makes a numbered Release that pins the draft and points the live Release at it", async () => {
    const { rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({
      id,
      draft: {
        jobText: "Answer pricing questions",
        switches: { quotePrices: true },
        skills: [{ name: "Refunds", text: "Refund within 30 days." }],
        tools: ["reply"],
        model: "openai:gpt-6-luna",
      },
    });

    const release = await rpc.representative.approve({ id });

    expect(release).toMatchObject({
      number: 1,
      content: {
        jobText: "Answer pricing questions",
        switches: { quotePrices: true },
        skills: [{ name: "Refunds", text: "Refund within 30 days." }],
        tools: ["reply"],
        model: "openai:gpt-6-luna",
        documentSnapshot: null,
        tests: [],
      },
    });
    const view = await rpc.representative.get({ id });
    expect(view).toMatchObject({ liveReleaseNumber: 1, liveRelease: { id: release.id } });
    expect(view.releases.map((item) => item.number)).toEqual([1]);
  });

  it("numbers each approval after the last, and two at once never share a number", async () => {
    const { rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer" } });

    const both = await Promise.all([
      rpc.representative.approve({ id }),
      rpc.representative.approve({ id }),
    ]);
    const third = await rpc.representative.approve({ id });

    expect(both.map((release) => release.number).sort()).toEqual([1, 2]);
    expect(third.number).toBe(3);
    expect((await rpc.representative.get({ id })).liveRelease?.id).toBe(third.id);
  });

  it("refuses a draft with no job text, and makes no Release", async () => {
    const { rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({ id, draft: { jobText: "   " } });

    await expect(rpc.representative.approve({ id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { code: "error.representativeJobTextBlank" },
    });
    expect(await releaseRows(id)).toEqual([]);
  });

  it("leaves the live Release as it was when the draft is edited", async () => {
    const { rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer pricing questions" } });
    const release = await rpc.representative.approve({ id });

    const edited = await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Answer anything", tools: ["reply"], model: "openai:gpt-6-luna" },
    });

    expect(edited.draft.jobText).toBe("Answer anything");
    expect(edited.liveRelease).toEqual(release);
    expect(edited.liveRelease?.content).toMatchObject({
      jobText: "Answer pricing questions",
      tools: ["reply", "hand_to_bot"],
      model: null,
    });
  });

  it("never changes a Release once approved, whatever is done to the Representative afterwards", async () => {
    const { rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer pricing questions" } });
    await rpc.representative.approve({ id });
    const [pinned] = await releaseRows(id);

    await rpc.representative.updateDraft({
      id,
      draft: { jobText: "Something else", skills: [{ name: "x", text: "y" }] },
    });
    await rpc.representative.setEnabled({ id, enabled: true });
    await rpc.representative.setEnabled({ id, enabled: false });
    await rpc.representative.approve({ id });

    const [first, second] = await releaseRows(id);
    expect(first).toEqual(pinned);
    expect(first!.content.jobText).toBe("Answer pricing questions");
    expect(second!.content.jobText).toBe("Something else");
  });
});

describe("switching on and off", () => {
  it("switches on only once a Release is live, and changes without a new Release", async () => {
    const { rpc } = await owner();
    const { id } = await rpc.representative.create({ name: "Front desk" });

    await expect(rpc.representative.setEnabled({ id, enabled: true })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { code: "error.representativeNoRelease" },
    });
    expect((await rpc.representative.get({ id })).enabled).toBe(false);

    await rpc.representative.updateDraft({ id, draft: { jobText: "Answer" } });
    const release = await rpc.representative.approve({ id });
    expect((await rpc.representative.setEnabled({ id, enabled: true })).enabled).toBe(true);
    expect(await releaseRows(id)).toHaveLength(1);
    const off = await rpc.representative.setEnabled({ id, enabled: false });

    expect(off).toMatchObject({ enabled: false, liveRelease: { id: release.id } });
    expect(await releaseRows(id)).toHaveLength(1);
  });
});

describe("a user's delete and export", () => {
  it("exports every Representative with its draft and Releases, and delete removes them for that user only", async () => {
    const { deps, user, rpc } = await owner();
    const { rpc: othersRpc } = await another(deps);
    const mine = await rpc.representative.create({ name: "Front desk" });
    await rpc.representative.updateDraft({ id: mine.id, draft: { jobText: "Answer" } });
    await rpc.representative.approve({ id: mine.id });
    await rpc.representative.updateDraft({ id: mine.id, draft: { jobText: "Answer more" } });
    const theirs = await othersRpc.representative.create({ name: "Theirs" });
    await othersRpc.representative.updateDraft({ id: theirs.id, draft: { jobText: "Hello" } });
    await othersRpc.representative.approve({ id: theirs.id });

    const exported = (await exportUserData(deps, user.id)) as unknown as {
      representative: {
        representatives: Array<{ name: string; draft: { jobText: string }; releases: unknown[] }>;
      };
    };
    expect(exported.representative.representatives).toMatchObject([
      { name: "Front desk", draft: { jobText: "Answer more" }, releases: [{ number: 1 }] },
    ]);

    await deleteUserData(deps, user.id);

    expect(
      await getTestDb()
        .select()
        .from(representativeTable)
        .where(eq(representativeTable.userId, user.id)),
    ).toEqual([]);
    expect(await releaseRows(mine.id)).toEqual([]);
    expect(await releaseRows(theirs.id)).toHaveLength(1);
    expect(await othersRpc.representative.list()).toHaveLength(1);
  });
});

describe("a Host that doesn't enable the feature", () => {
  it("has no Representatives on its SDK, and no procedures", async () => {
    const sdk = createBotSdk({
      database: postgres({ connectionString: testDatabaseUrl }),
      keyEncryptionSecrets: ["test-key-encryption-secret-not-for-production"],
      models: {},
    });

    expect("representative" in sdk).toBe(false);
  });

  it("gives the feature no Turn hooks: Auto-review and Custom Rules, which act on a Bot's Turns, never reach it", () => {
    const feature = representative();

    for (const hook of ["tools", "prompt", "afterTurn", "turnChanges", "resetBot"] as const) {
      expect(feature[hook], hook).toBeUndefined();
    }
  });
});
