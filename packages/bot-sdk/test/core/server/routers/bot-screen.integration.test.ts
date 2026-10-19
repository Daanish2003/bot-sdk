import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botHelper, computer as computerTable } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { askUserToolName } from "../../../../plugins/bot/server/hand-off";
import { bot } from "../../../../plugins/bot/server/plugin";
import type { ScreenPeer } from "../../../../plugins/bot/server/screen-view";
import { computer } from "../../../../plugins/computer/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeNovnc } from "../../../support/fake-novnc";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };
const minuteMs = 60_000;

/** What each test started, stopped after it. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) => String(prompt).startsWith("You are a Helper"));

const task = "Read the deals on the Salesforce dashboard.";
const reason = "Sign in to Salesforce: enter your password and the code from your phone.";

/**
 * A user with a Bot whose Computer-use Helper is waiting for them at a hand-off, over an SDK with
 * `computer` on. Each Screen's noVNC port is a fake noVNC that wants E2B's traffic token; no Chrome
 * answers on the DevTools ports. The clock is the real time plus `offset.ms`.
 */
async function waitingHelper() {
  const novnc = await fakeNovnc();
  const offset = { ms: 0 };
  const clock = () => new Date(Date.now() + offset.ms);
  const turnFake = createFakeAdapter({
    rounds: [
      round(
        toolCall({ name: "start_helper", input: { type: "computer_use", task } }),
        toolCall({ name: "send_to_user", input: { text: "On it.", endTurn: true } }),
      ),
      round(),
    ],
  });
  const helperFake = createFakeAdapter({
    rounds: [round(toolCall({ name: askUserToolName, input: { reason } }))],
  });
  const adapter = {
    ...turnFake.adapter,
    chatStream: (options: TextOptions) =>
      isHelperCall(options)
        ? helperFake.adapter.chatStream(options)
        : turnFake.adapter.chatStream(options),
  } as AnyTextAdapter;
  const computerFake = fakeComputerProvider({
    hostUrl: (_sandboxId, port) =>
      port >= 6081 && port <= 6084 ? novnc.origin : "http://127.0.0.1:1",
  });
  let deps: TestDeps | undefined;
  const jobs: InProcessRunner = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    deps: () => deps!,
    clock: { ...systemClock, now: clock },
  });
  deps = createTestSdk({
    plugins: [bot(), computer({ provider: computerFake.provider })],
    jobs,
    adapterFor: () => adapter,
    clock,
  });
  await jobs.start();
  cleanups.push(
    () => jobs.stop(),
    () => novnc.close(),
  );
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model });
  for await (const _event of await client.bot.send({ botId, id: uuidv7(), text: "deals?" }));
  await expect
    .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
    .toBe("waiting");
  const helper = (await helpersOf(botId))[0]!;
  return { novnc, offset, computerFake, deps, client, user, botId, helper };
}

const helpersOf = async (botId: string) =>
  getTestDb()
    .select()
    .from(botHelper)
    .where(eq(botHelper.botId, botId))
    .orderBy(asc(botHelper.startedAt));

const screenCommands = (fake: ReturnType<typeof fakeComputerProvider>) =>
  fake
    .callsOf("run")
    .map((call) => call.command)
    .filter((command) => command.startsWith("/usr/local/bin/ai-chat-screen"));

/** The newest sandbox's id and the token its Screen 1 was opened with. */
const sandboxOf = (fake: ReturnType<typeof fakeComputerProvider>) => ({
  sandboxId: fake.callsOf("create").at(-1)!.sandboxId,
  screenToken: new TextDecoder().decode(fake.files.get("/tmp/screens/1/token")),
});

const lastActiveAt = async (userId: string) =>
  (await getTestDb().select().from(computerTable).where(eq(computerTable.userId, userId)))[0]
    ?.lastActiveAt;

/** A link's page request, at the Host's origin. */
const pageRequest = (link: string) => new Request(new URL(link, "https://bots.example"));

/** The socket noVNC opens from a link's page: its `path`, at the Host's origin. */
const socketRequest = (link: string) =>
  new Request(
    `https://bots.example/${new URL(link, "https://bots.example").searchParams.get("path")}`,
    { headers: { "sec-websocket-protocol": "binary" } },
  );

/** A stand-in for the Host's WebSocket peer: what the proxy sends the browser, and its close. */
function fakePeer(context: Record<string, unknown>) {
  const sent: number[][] = [];
  const peer: ScreenPeer & { closed: boolean } = {
    context,
    closed: false,
    send: (data) => {
      sent.push(typeof data === "string" ? [...Buffer.from(data)] : [...data]);
    },
    close: () => {
      peer.closed = true;
    },
  };
  return { peer, sent };
}

describe("bot.screen.view", () => {
  it("gives the owner a fresh live-view link carrying neither the traffic token nor the Screen's token", async () => {
    const { client, helper, computerFake } = await waitingHelper();
    const before = screenCommands(computerFake).length;

    const { url } = await client.bot.screen.view({ helperId: helper.id });

    const { sandboxId, screenToken } = sandboxOf(computerFake);
    expect(url).toMatch(/^\/api\/screens\/[^/]+\/vnc\.html\?/);
    expect(url).not.toContain(sandboxId);
    expect(url).not.toContain(screenToken);
    const path = new URL(url, "https://bots.example").searchParams.get("path");
    expect(path).toBe(`${url.slice(1).split("/vnc.html")[0]}/websockify`);
    // A link leaves the Screen's control as it is: taking control is Take control's alone.
    expect(screenCommands(computerFake).slice(before)).toEqual([]);
  });

  it("finds no Helper of another user's", async () => {
    const { deps, helper } = await waitingHelper();
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.bot.screen.view({ helperId: helper.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      other.bot.screen.control({ helperId: helper.id, mode: "control" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("wakes the Computer and reopens the Screen when it isn't open", async () => {
    const { client, deps, helper, computerFake, botId } = await waitingHelper();
    computerFake.lose(sandboxOf(computerFake).sandboxId);
    const before = screenCommands(computerFake).length;

    const { url } = await client.bot.screen.view({ helperId: helper.id });

    expect(computerFake.callsOf("create")).toHaveLength(2);
    expect(screenCommands(computerFake).slice(before)).toEqual([
      `/usr/local/bin/ai-chat-screen start 1 ${botId}`,
    ]);
    expect((await deps.plugin("bot").screenHandler(pageRequest(url))).status).toBe(200);
  });

  it("refuses once the task was stopped, and its link stops working", async () => {
    const { client, deps, helper, botId } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });

    await client.bot.helper.stop({ botId, helperId: helper.id });

    await expect(client.bot.screen.view({ helperId: helper.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This task was stopped.",
    });
    expect((await deps.plugin("bot").screenHandler(pageRequest(url))).status).toBe(404);
  });
});

describe("bot.screen.control", () => {
  it("switches the Screen's x11vnc between control and view-only", async () => {
    const { client, helper, computerFake } = await waitingHelper();

    await client.bot.screen.control({ helperId: helper.id, mode: "control" });
    await client.bot.screen.control({ helperId: helper.id, mode: "view" });

    expect(screenCommands(computerFake).slice(-2)).toEqual([
      "/usr/local/bin/ai-chat-screen control 1",
      "/usr/local/bin/ai-chat-screen view 1",
    ]);
  });
});

describe("bot.helper.done", () => {
  it("makes the Screen view-only again, even when the user's client didn't give control back", async () => {
    const { client, helper, computerFake } = await waitingHelper();
    await client.bot.screen.control({ helperId: helper.id, mode: "control" });

    await client.bot.helper.done({ helperId: helper.id });

    await expect
      .poll(() => screenCommands(computerFake).at(-1))
      .toBe("/usr/local/bin/ai-chat-screen view 1");
  });
});

describe("the live view's proxy", () => {
  it("serves the noVNC page and its files from the Screen, adding the traffic token upstream", async () => {
    const { client, deps, helper, novnc, computerFake } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });
    const handler = deps.plugin("bot").screenHandler;
    const asked = () => computerFake.callsOf("endpoint").length;
    const askedByLink = asked();

    const page = await handler(pageRequest(url));
    const file = await handler(pageRequest(url.replace(/vnc\.html.*$/, "app/ui.js")));

    expect(page.status).toBe(200);
    // The sandbox wrote it, so it runs in an opaque origin, not the Host's.
    expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(await page.text()).toMatch(/^noVNC \/vnc\.html\?/);
    expect(await file.text()).toBe("noVNC /app/ui.js");
    // The Screen's address the link asked for is reused, not asked for again for each file.
    expect(asked()).toBe(askedByLink);
    const { sandboxId } = sandboxOf(computerFake);
    // Screen 1's noVNC endpoint's own headers, not the DevTools one's: on the Embed they pick the port.
    expect(
      novnc.requests.map((request) => [
        request.headers["e2b-traffic-access-token"],
        request.headers["fake-port"],
      ]),
    ).toEqual([
      [`traffic-${sandboxId}`, "6081"],
      [`traffic-${sandboxId}`, "6081"],
    ]);
  });

  it("keeps a redirect within noVNC on the proxy, and drops any other", async () => {
    const { client, deps, helper } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });
    const base = url.split("/vnc.html")[0]!;
    const handler = deps.plugin("bot").screenHandler;

    const within = await handler(pageRequest(`${base}/redirect?to=/vnc.html%3Fa%3D1`));
    const away = await handler(pageRequest(`${base}/redirect?to=https://elsewhere.example/`));

    expect(within.status).toBe(302);
    expect(within.headers.get("location")).toBe(`${base}/vnc.html?a=1`);
    expect(away.status).toBe(302);
    expect(away.headers.get("location")).toBeNull();
  });

  it("answers 502 when the Screen can't be reached, on the page and the socket alike", async () => {
    const { client, deps, helper, computerFake, offset } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });
    // A minute on, past the reused address, the sandbox is gone and its rebuild has no Screen open.
    offset.ms = minuteMs;
    computerFake.lose(sandboxOf(computerFake).sandboxId);

    expect((await deps.plugin("bot").screenHandler(pageRequest(url))).status).toBe(502);
    await expect(deps.plugin("bot").screenSocket.upgrade(socketRequest(url))).rejects.toMatchObject(
      { status: 502 },
    );
  });

  it("answers 403 without a valid view token, and reaches nothing upstream", async () => {
    const { client, deps, helper, novnc, offset } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });
    const token = url.split("/")[3]!;
    const handler = deps.plugin("bot").screenHandler;
    const forged = `${token.slice(0, -2)}${token.endsWith("A") ? "B" : "A"}${token.slice(-1)}`;

    const refused = [
      await handler(pageRequest("/api/screens/vnc.html")),
      await handler(pageRequest(url.replace(token, "not-a-token"))),
      await handler(pageRequest(url.replace(token, forged))),
    ];
    // Ten minutes on, the link has expired.
    offset.ms = 11 * minuteMs;
    refused.push(await handler(pageRequest(url)));

    expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    await expect(deps.plugin("bot").screenSocket.upgrade(socketRequest(url))).rejects.toMatchObject(
      { status: 403 },
    );
    expect(novnc.requests).toEqual([]);
    expect(novnc.upgrades).toEqual([]);
  });

  it("proxies the socket to websockify with the traffic token and the Screen's token, both ways", async () => {
    const { client, deps, helper, novnc, computerFake } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });
    const hooks = deps.plugin("bot").screenSocket;

    const upgraded = await hooks.upgrade(socketRequest(url));
    expect(upgraded.protocol).toBe("binary");
    const { peer, sent } = fakePeer(upgraded.context);
    hooks.open(peer);
    hooks.message(peer, { uint8Array: () => new Uint8Array([1, 2, 3]) });

    await expect.poll(() => novnc.messages).toEqual([[1, 2, 3]]);
    const { sandboxId, screenToken } = sandboxOf(computerFake);
    expect(novnc.upgrades).toEqual([
      expect.objectContaining({
        path: `/websockify?token=${screenToken}`,
        headers: expect.objectContaining({
          "e2b-traffic-access-token": `traffic-${sandboxId}`,
          "fake-port": "6081",
          "sec-websocket-protocol": "binary",
        }),
      }),
    ]);
    novnc.send([9, 8, 7]);
    await expect.poll(() => sent).toEqual([[9, 8, 7]]);

    hooks.close(peer);
    await expect.poll(() => novnc.closes).toBe(1);
  });

  it("closes the browser's socket once the Screen's socket closes", async () => {
    const { client, deps, helper, novnc } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });
    const hooks = deps.plugin("bot").screenSocket;
    const { peer } = fakePeer((await hooks.upgrade(socketRequest(url))).context);
    hooks.open(peer);
    await expect.poll(() => novnc.upgrades.length).toBe(1);

    await novnc.close();

    await expect.poll(() => peer.closed).toBe(true);
  });

  it("counts the open live view as Computer activity, and stops once it closes", async () => {
    const { client, deps, helper, offset, user } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });
    const hooks = deps.plugin("bot").screenSocket;
    const { peer } = fakePeer((await hooks.upgrade(socketRequest(url))).context);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      hooks.open(peer);
      offset.ms = 4 * minuteMs;
      await vi.advanceTimersByTimeAsync(minuteMs);
      const beat = await vi.waitFor(async () => {
        const at = await lastActiveAt(user.id);
        expect(at!.getTime()).toBeGreaterThanOrEqual(Date.now() + 4 * minuteMs - 5_000);
        return at;
      });

      hooks.close(peer);
      offset.ms = 9 * minuteMs;
      await vi.advanceTimersByTimeAsync(5 * minuteMs);

      expect(await lastActiveAt(user.id)).toEqual(beat);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an open live view once its Helper is stopped", async () => {
    const { client, deps, helper, botId } = await waitingHelper();
    const { url } = await client.bot.screen.view({ helperId: helper.id });
    const hooks = deps.plugin("bot").screenSocket;
    const { peer } = fakePeer((await hooks.upgrade(socketRequest(url))).context);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      hooks.open(peer);
      await client.bot.helper.stop({ botId, helperId: helper.id });

      await vi.advanceTimersByTimeAsync(minuteMs);

      await vi.waitFor(() => expect(peer.closed).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });
});
