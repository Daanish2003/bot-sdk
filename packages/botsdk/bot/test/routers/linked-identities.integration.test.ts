import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../src/create-chat";
import type { BotSdkPlugin } from "../../src/plugin";
import { botTrigger, channelAccount, linkCode, linkedIdentity } from "../../src/storage";
import { deleteUserData, exportUserData } from "../../src/user-data";
import { saveCredentials } from "../../src/models/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { chatRpc } from "@ai-chat/test-support/sdk";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { CredentialsRejectedError } from "@botsdk/bot/channel/internal";
import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";

/*
 * Linked identities and link codes (spec #1044, ticket #1046): the `channels.identities` RPCs, and
 * an unknown sender's link code arriving on a Channel account's listener (the fake adapter).
 */

const timeout = { timeout: 30_000 };
const poll = { timeout: 10_000 };
const model = "openai:gpt-6-luna";

const started: { part: BotSdkPlugin; deps: TestDeps }[] = [];

afterEach(async () => {
  for (const { part, deps } of started.splice(0)) await part.stop!(deps);
});

type Fake = ReturnType<typeof fakeMessagingAdapter>;

/** An instance with the fake messaging adapter, whose clock `clock.now` moves. */
function messagingSdk(logger?: Logger) {
  const fake = fakeMessagingAdapter();
  const clock = { now: Date.now() };
  const deps = createTestSdk({
    channels: [fake.adapter],
    clock: () => new Date(clock.now),
    ...(logger && { logger }),
  });
  return { deps, fake, clock };
}

/** Saves a Channel account `@bot_<id>` on `botId`. */
async function connect(client: ReturnType<typeof chatRpc>, botId: string, id: string) {
  await client.channels.accounts.save({
    botId,
    platform: "fake",
    credentials: { token: `${id}:secret-${id}` },
  });
}

/** Starts the listeners, as `sdk.start()` does, once every account is saved, and waits for `ids`. */
async function listen(deps: TestDeps, fake: Fake, ...ids: string[]) {
  const part = deps.parts.all.find((candidate) => candidate.id === "channel")!;
  await part.start!(deps);
  started.push({ part, deps });
  for (const id of ids) {
    await expect.poll(() => fake.listening.has(`@bot_${id}`), poll).toBe(true);
  }
}

/** A user with a Bot whose Channel account is `@bot_<id>` on the fake platform. */
async function aBot(deps: TestDeps, id: string) {
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await deps.bots.create({ userId: user.id, name: `Bot ${id}`, model });
  await connect(client, botId, id);
  return { user, client, botId };
}

const identitiesOf = (userId: string) =>
  getTestDb().select().from(linkedIdentity).where(eq(linkedIdentity.userId, userId));

const codesOf = (userId: string) =>
  getTestDb().select().from(linkCode).where(eq(linkCode.userId, userId));

/** The Bot's Channel account row, or `undefined` before it is saved. */
const accountOf = async (botId: string) =>
  (await getTestDb().select().from(channelAccount).where(eq(channelAccount.botId, botId)))[0];

const from = (id: string, handle = `@user${id}`) => ({
  sender: { id, handle },
  chat: { id, private: true },
});

describe("channels.identities.linkCode", () => {
  it(
    "issues a 6-digit code valid 10 minutes with the deep links of the user's Bots",
    timeout,
    async () => {
      const { deps, clock } = messagingSdk();
      const ada = await aBot(deps, "1");

      const issued = await ada.client.channels.identities.linkCode();

      expect(issued.code).toMatch(/^\d{6}$/);
      expect(issued.expiresAt.getTime()).toBe(clock.now + 10 * 60_000);
      expect(issued.links).toEqual([
        {
          platform: "fake",
          botId: ada.botId,
          botName: "Bot 1",
          handle: "@bot_1",
          url: `https://fake.example/bot_1?start=${issued.code}`,
        },
      ]);
      // Stored hashed.
      expect((await codesOf(ada.user.id))[0]!.codeHash).not.toContain(issued.code);
    },
  );

  it("keeps one live code per user: a new one replaces the old one", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const ada = await aBot(deps, "1");
    await listen(deps, fake, "1");
    const first = await ada.client.channels.identities.linkCode();
    const second = await ada.client.channels.identities.linkCode();

    expect(await codesOf(ada.user.id)).toHaveLength(1);
    if (first.code !== second.code) {
      await fake.deliver("@bot_1", { ...from("1001"), text: first.code });
      expect(await identitiesOf(ada.user.id)).toEqual([]);
    }
  });

  it("isn't served without a messaging adapter", timeout, async () => {
    const user = await insertUser();
    const client = chatRpc({ user, deps: createTestSdk() });

    await expect(client.channels.identities.list()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("an unknown sender's link code", () => {
  it(
    "links the sender, spends the code, and sends a system notice on the Channel",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const ada = await aBot(deps, "1");
      await listen(deps, fake, "1");
      const { code } = await ada.client.channels.identities.linkCode();

      await fake.deliver("@bot_1", { ...from("1001", "@ada"), text: code });

      expect(await ada.client.channels.identities.list()).toEqual([
        { platform: "fake", handle: "@ada", linkedAt: expect.any(Date) },
      ]);
      expect(fake.sends).toHaveLength(1);
      expect(fake.sends[0]).toMatchObject({
        account: { handle: "@bot_1" },
        message: { chatId: "1001", text: "Linked to your account." },
      });
      // Spent: another sender can't use it.
      await fake.deliver("@bot_1", { ...from("2002"), text: code });
      expect(await identitiesOf(ada.user.id)).toHaveLength(1);
      expect(fake.sends).toHaveLength(1);
    },
  );

  it("takes Telegram's /start <code> too, on any of the user's Bots", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const ada = await aBot(deps, "1");
    const { id: second } = await deps.bots.create({ userId: ada.user.id, name: "Grace", model });
    await connect(ada.client, second, "2");
    await listen(deps, fake, "1", "2");
    const { code } = await ada.client.channels.identities.linkCode();

    await fake.deliver("@bot_2", { ...from("1001"), text: `/start ${code}` });

    expect(await identitiesOf(ada.user.id)).toHaveLength(1);
  });

  it(
    "keeps the link when the token is rejected sending the notice, and marks the account",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const ada = await aBot(deps, "1");
      await listen(deps, fake, "1");
      const { code } = await ada.client.channels.identities.linkCode();
      vi.spyOn(fake.adapter, "send").mockRejectedValueOnce(
        new CredentialsRejectedError("Unauthorized"),
      );

      await fake.deliver("@bot_1", { ...from("1001", "@ada"), text: code });

      expect(await identitiesOf(ada.user.id)).toHaveLength(1);
      expect(await accountOf(ada.botId)).toMatchObject({
        status: "needs_attention",
        reason: "Unauthorized",
      });
      await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(false);
    },
  );

  it(
    "takes the sender's next message once the token is fixed, not as a stale link attempt",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const ada = await aBot(deps, "1");
      await listen(deps, fake, "1");
      const { code } = await ada.client.channels.identities.linkCode();
      vi.spyOn(fake.adapter, "send").mockRejectedValueOnce(
        new CredentialsRejectedError("Unauthorized"),
      );
      await fake.deliver("@bot_1", { ...from("1001", "@ada"), text: code });
      await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(false);
      const listens = fake.counts.listens;

      await ada.client.channels.accounts.save({
        botId: ada.botId,
        platform: "fake",
        credentials: { token: "1:secret-1" },
      });
      await expect.poll(async () => (await accountOf(ada.botId))?.status, poll).toBe("active");
      await expect.poll(() => fake.listening.has("@bot_1"), poll).toBe(true);
      expect(fake.counts.listens).toBe(listens + 1);
      await fake.deliver("@bot_1", { ...from("1001", "@ada"), sourceId: "900", text: "hello" });

      const account = await accountOf(ada.botId);
      const triggers = await getTestDb()
        .select()
        .from(botTrigger)
        .where(eq(botTrigger.id, `fake:${account!.id}:900`));
      expect(triggers).toHaveLength(1);
    },
  );

  it("logs another failure sending the notice, and keeps the link", timeout, async () => {
    const error = vi.fn();
    const { deps, fake } = messagingSdk({ error, debug: () => {} });
    const ada = await aBot(deps, "1");
    await listen(deps, fake, "1");
    const { code } = await ada.client.channels.identities.linkCode();
    vi.spyOn(fake.adapter, "send").mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"));

    await fake.deliver("@bot_1", { ...from("1001", "@ada"), text: code });

    expect(await identitiesOf(ada.user.id)).toHaveLength(1);
    expect(await accountOf(ada.botId)).toMatchObject({ status: "active" });
    expect(error).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });

  it(
    "drops silently a wrong, expired or embedded code, and one sent in a group",
    timeout,
    async () => {
      const { deps, fake, clock } = messagingSdk();
      const ada = await aBot(deps, "1");
      await listen(deps, fake, "1");
      const { code } = await ada.client.channels.identities.linkCode();
      const wrong = code === "000000" ? "000001" : "000000";

      await fake.deliver("@bot_1", { ...from("1001"), text: wrong });
      await fake.deliver("@bot_1", { ...from("1001"), text: `my code is ${code}` });
      await fake.deliver("@bot_1", {
        sender: { id: "1001", handle: "@ada" },
        chat: { id: "-5", private: false },
        text: code,
      });
      clock.now += 10 * 60_000 + 1;
      await fake.deliver("@bot_1", { ...from("1001"), text: code });

      expect(await identitiesOf(ada.user.id)).toEqual([]);
      expect(fake.sends).toEqual([]);
    },
  );

  /** `count` 6-digit codes that aren't `code`. */
  const missesOf = (code: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      String((Number(code) + i + 1) % 1_000_000).padStart(6, "0"),
    );

  it(
    "voids the live code after 5 wrong guesses on any of the user's Bots, even if the next is right",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const ada = await aBot(deps, "1");
      const { id: other } = await deps.bots.create({ userId: ada.user.id, name: "Bot 4", model });
      await connect(ada.client, other, "4");
      await listen(deps, fake, "1", "4");
      const { code } = await ada.client.channels.identities.linkCode();

      for (const [index, miss] of missesOf(code, 5).entries()) {
        await fake.deliver(index % 2 ? "@bot_4" : "@bot_1", { ...from("3003"), text: miss });
      }
      await fake.deliver("@bot_1", { ...from("1001"), text: code });

      expect(await identitiesOf(ada.user.id)).toEqual([]);
      expect(fake.sends).toEqual([]);
      // A new code from Settings works again.
      await fake.deliver("@bot_1", {
        ...from("1001"),
        text: (await ada.client.channels.identities.linkCode()).code,
      });
      expect(await identitiesOf(ada.user.id)).toHaveLength(1);
    },
  );

  it("takes the right code after 4 wrong guesses", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const ada = await aBot(deps, "1");
    await listen(deps, fake, "1");
    const { code } = await ada.client.channels.identities.linkCode();

    for (const miss of missesOf(code, 4)) {
      await fake.deliver("@bot_1", { ...from("3003"), text: miss });
    }
    await fake.deliver("@bot_1", { ...from("1001"), text: code });

    expect(await identitiesOf(ada.user.id)).toHaveLength(1);
  });

  it("acts once on a resent link code, also after the listener restarts", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const ada = await aBot(deps, "1");
    await listen(deps, fake, "1");
    const { code, expiresAt } = await ada.client.channels.identities.linkCode();
    const { codeHash } = (await codesOf(ada.user.id))[0]!;
    const first = { ...from("1001"), sourceId: "77", text: code };
    await fake.deliver("@bot_1", first);
    await ada.client.channels.identities.unlink({ platform: "fake" });
    // The resent update finds the user unlinked, and a live code with the same digits.
    await getTestDb().insert(linkCode).values({ userId: ada.user.id, codeHash, expiresAt });
    const { part } = started.splice(0)[0]!;
    await part.stop!(deps);
    await listen(deps, fake, "1");
    const sent = fake.sends.length;

    await fake.deliver("@bot_1", first);

    expect(await identitiesOf(ada.user.id)).toEqual([]);
    expect(fake.sends).toHaveLength(sent);
  });

  it("logs each silent drop at debug, without the text or the code", timeout, async () => {
    const debug = vi.fn();
    const { deps, fake } = messagingSdk({ error: () => {}, debug });
    const ada = await aBot(deps, "1");
    const eve = await aBot(deps, "2");
    await listen(deps, fake, "1", "2");
    await fake.deliver("@bot_2", {
      ...from("1001", "@ada"),
      text: (await eve.client.channels.identities.linkCode()).code,
    });
    const { code } = await ada.client.channels.identities.linkCode();
    const wrong = code === "000000" ? "000001" : "000000";
    debug.mockClear();

    await fake.deliver("@bot_1", { ...from("3003"), text: "hello there" });
    await fake.deliver("@bot_1", { ...from("3003"), text: wrong });
    await fake.deliver("@bot_1", { ...from("1001", "@ada"), text: code });

    const lines = debug.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(3);
    expect(lines.join(" | ")).not.toMatch(/hello there|[0-9]{6}/);
    expect(lines[0]).toContain("not a link code");
    expect(lines[1]).toContain("wrong, expired or spent");
    expect(lines[2]).toContain("linked to another user");
  });

  it("leaves a linked sender's message alone, and the code unspent", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const ada = await aBot(deps, "1");
    await listen(deps, fake, "1");
    await fake.deliver("@bot_1", {
      ...from("1001", "@ada"),
      text: (await ada.client.channels.identities.linkCode()).code,
    });
    fake.sends.length = 0;
    const { code } = await ada.client.channels.identities.linkCode();

    await fake.deliver("@bot_1", { ...from("1001", "@ada"), text: code });

    expect(fake.sends).toEqual([]);
    expect(await codesOf(ada.user.id)).toHaveLength(1);
  });

  it("doesn't take a code sent to another user's Bot", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const ada = await aBot(deps, "1");
    await aBot(deps, "2");
    await listen(deps, fake, "1", "2");
    const { code } = await ada.client.channels.identities.linkCode();

    await fake.deliver("@bot_2", { ...from("1001"), text: code });

    expect(await identitiesOf(ada.user.id)).toEqual([]);
    expect(await codesOf(ada.user.id)).toHaveLength(1);
  });

  it(
    "refuses silently a sender linked to someone else, and the code stays unspent",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const ada = await aBot(deps, "1");
      const eve = await aBot(deps, "2");
      await listen(deps, fake, "1", "2");
      await fake.deliver("@bot_2", {
        ...from("1001", "@ada"),
        text: (await eve.client.channels.identities.linkCode()).code,
      });
      fake.sends.length = 0;
      const { code } = await ada.client.channels.identities.linkCode();

      await fake.deliver("@bot_1", { ...from("1001", "@ada"), text: code });

      expect(await identitiesOf(ada.user.id)).toEqual([]);
      expect(await identitiesOf(eve.user.id)).toHaveLength(1);
      expect(fake.sends).toEqual([]);
      expect(await codesOf(ada.user.id)).toHaveLength(1);
    },
  );

  it(
    "replaces the identity on the platform when the user links again, and unlinking is at once",
    timeout,
    async () => {
      const { deps, fake } = messagingSdk();
      const ada = await aBot(deps, "1");
      const grace = await aBot(deps, "3");
      await listen(deps, fake, "1", "3");
      await fake.deliver("@bot_1", {
        ...from("1001", "@old"),
        text: (await ada.client.channels.identities.linkCode()).code,
      });

      await fake.deliver("@bot_1", {
        ...from("2002", "@new"),
        text: (await ada.client.channels.identities.linkCode()).code,
      });

      expect(await ada.client.channels.identities.list()).toMatchObject([{ handle: "@new" }]);
      await ada.client.channels.identities.unlink({ platform: "fake" });
      expect(await ada.client.channels.identities.list()).toEqual([]);
      // The old account is free to link again, to anyone.
      await fake.deliver("@bot_3", {
        ...from("1001", "@old"),
        text: (await grace.client.channels.identities.linkCode()).code,
      });
      expect(await identitiesOf(grace.user.id)).toHaveLength(1);
    },
  );
});

describe("user data", () => {
  it("is deleted with the user, and exported without credentials", timeout, async () => {
    const { deps, fake } = messagingSdk();
    const ada = await aBot(deps, "1");
    await listen(deps, fake, "1");
    await fake.deliver("@bot_1", {
      ...from("1001", "@ada"),
      text: (await ada.client.channels.identities.linkCode()).code,
    });
    await ada.client.channels.identities.linkCode();

    const exported = JSON.stringify((await exportUserData(deps, ada.user.id)).channel);

    expect(exported).toContain("@ada");
    expect(exported).toContain("@bot_1");
    expect(exported).not.toContain("secret-1");
    expect(exported).not.toContain("encrypted");
    await deleteUserData(deps, ada.user.id);
    expect(await identitiesOf(ada.user.id)).toEqual([]);
    expect(await codesOf(ada.user.id)).toEqual([]);
  });
});
