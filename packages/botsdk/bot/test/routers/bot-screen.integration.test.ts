import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { botHelper, botTrigger, computer as computerTable, job } from "../../src/storage";
import { uuidv7 } from "../../src/lib/uuidv7";
import { askUserToolName, closeScreen, lockScreen } from "../../src/bot/helpers";
import type { ScreenPeer } from "../../src/bot/helpers";
import { saveCredentials } from "../../src/models/internal";
import { inProcessRunner, type JobRunner, systemClock } from "../../src/runner/internal";
import { createTestSdk, type TestDeps } from "@ai-chat/test-support/deps";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { fakeNovnc } from "@ai-chat/test-support/fake-novnc";
import { chatRpc, createTestChat } from "@ai-chat/test-support/sdk";
import { createScreenSocketOver } from "../../src/over";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertUser } from "@ai-chat/test-support/users";
import { fakeComputerProvider, type FakeCommandRun } from "@botsdk/testing/fake-computer-provider";
import type { CommandResult } from "../../src/computer/internal";
import { followSend } from "@ai-chat/test-support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const minuteMs = 60_000;

/** What each test started, stopped after it. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) =>
    (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
  );

const task = "Read the deals on the Salesforce dashboard.";
const reason = "Sign in to Salesforce: enter your password and the code from your phone.";

/**
 * A user with a Bot whose Computer-use Helper is waiting for them at a hand-off, over an SDK with
 * `computer` on. Each Screen's noVNC port is a fake noVNC that wants E2B's traffic token; no Chrome
 * answers on the DevTools ports. The clock is the real time plus `offset.ms`. `onCommand` answers the
 * sandbox's commands. With `nextHelper`, the Bot's next Turn starts another Computer-use Helper, which
 * waits at a hand-off too.
 */
async function waitingHelper(
  onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>,
  { liveViewBase, nextHelper = false }: { liveViewBase?: string; nextHelper?: boolean } = {},
) {
  const novnc = await fakeNovnc();
  const offset = { ms: 0 };
  const clock = () => new Date(Date.now() + offset.ms);
  const startingTurn = [
    round(
      toolCall({ name: "start_helper", input: { type: "computer_use", task } }),
      toolCall({ name: "send_to_user", input: { text: "On it.", endTurn: true } }),
    ),
    round(),
  ];
  const askingHelper = [round(toolCall({ name: askUserToolName, input: { reason } }))];
  const turnFake = createFakeAdapter({
    rounds: nextHelper ? [...startingTurn, ...startingTurn] : startingTurn,
  });
  const helperFake = createFakeAdapter({
    rounds: nextHelper ? [...askingHelper, ...askingHelper] : askingHelper,
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
    ...(onCommand && { onCommand }),
  });
  let deps: TestDeps | undefined;
  const jobs: JobRunner = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
    clock: { ...systemClock, now: clock },
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    jobs,
    adapterFor: () => adapter,
    clock,
    liveViewBase,
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
  const { id: botId } = await client.bots.create({ name: "Ada", model });
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: "deals?" }));
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

/** How many database sessions, in any process, wait for the user's Screen `slot`'s lock now. */
const waitingForScreenLock = async (userId: string, slot: number) => {
  const { rows } = await getTestDb().execute(sql`
    select count(*)::int as waiting from pg_locks
    where locktype = 'advisory' and not granted
      and database = (select oid from pg_database where datname = current_database())
      and (classid::bigint << 32 | objid::bigint) = hashtextextended(${`screen:${userId}:${slot}`}, 0)
  `);
  return (rows[0] as { waiting: number }).waiting;
};

/** A beat queries the database twice, which can take more than `vi.waitFor`'s default 1 s under load. */
const beatTimeout = { timeout: 10_000 };

const lastActiveAt = async (userId: string) =>
  (await getTestDb().select().from(computerTable).where(eq(computerTable.userId, userId)))[0]
    ?.lastActiveAt;

/** A link's page request, at the Host's origin. */
/** The live view's page routes, served by the HTTP handler to a signed-out browser. */
const screenHandlerOf = (deps: TestDeps) => createTestChat({ deps }).fetch;

/** The live view's socket hooks, mounted at the HTTP handler's basePath. */
const screenSocketOf = (deps: TestDeps) => createScreenSocketOver(deps, { basePath: "/api/chat" });

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

    const { url } = await client.computer.view({ helperId: helper.id });

    const { sandboxId, screenToken } = sandboxOf(computerFake);
    expect(url).toMatch(/^\/api\/chat\/screens\/[^/]+\/vnc\.html\?/);
    expect(url).not.toContain(sandboxId);
    expect(url).not.toContain(screenToken);
    const path = new URL(url, "https://bots.example").searchParams.get("path");
    expect(path).toBe(`${url.slice(1).split("/vnc.html")[0]}/websockify`);
    // A link leaves the Screen's control as it is: taking control is Take control's alone.
    expect(screenCommands(computerFake).slice(before)).toEqual([]);
  });

  it("points a link under createBotSdk's liveViewBase, called in-process, whatever the handler's basePath", async () => {
    const { deps, user, helper } = await waitingHelper(undefined, { liveViewBase: "/chat/" });

    const { url } = await deps.screens.view({ userId: user.id, helperId: helper.id });

    expect(url).toMatch(/^\/chat\/screens\/[^/]+\/vnc\.html\?/);
    expect(new URL(url, "https://bots.example").searchParams.get("path")).toMatch(
      /^chat\/screens\/[^/]+\/websockify$/,
    );
  });

  it("finds no Helper of another user's", async () => {
    const { deps, helper } = await waitingHelper();
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.computer.view({ helperId: helper.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      other.computer.control({ helperId: helper.id, mode: "control" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("wakes the Computer and reopens the Screen when it isn't open", async () => {
    const { client, deps, helper, computerFake, botId } = await waitingHelper();
    computerFake.lose(sandboxOf(computerFake).sandboxId);
    const before = screenCommands(computerFake).length;

    const { url } = await client.computer.view({ helperId: helper.id });

    expect(computerFake.callsOf("create")).toHaveLength(2);
    expect(screenCommands(computerFake).slice(before)).toEqual([
      `/usr/local/bin/ai-chat-screen start 1 ${botId}`,
    ]);
    expect((await screenHandlerOf(deps)(pageRequest(url))).status).toBe(200);
  });

  it("refuses once the task was stopped, and its link stops working", async () => {
    const { client, deps, helper, botId } = await waitingHelper();
    const { url } = await client.computer.view({ helperId: helper.id });

    await client.helpers.stop({ botId, helperId: helper.id });

    await expect(client.computer.view({ helperId: helper.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This task was stopped.",
    });
    expect((await screenHandlerOf(deps)(pageRequest(url))).status).toBe(404);
  });
});

describe("stopping a Computer-use Helper", () => {
  it("commits the stop before it closes the Screen, which can take a while", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let closing = false;
    const { client, helper, botId } = await waitingHelper(async ({ command }) => {
      if (command.endsWith("ai-chat-screen stop 1")) {
        closing = true;
        await held;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const stopping = client.helpers.stop({ botId, helperId: helper.id });
    try {
      await expect.poll(() => closing, { timeout: 10_000 }).toBe(true);

      // Read on another connection while the Screen is still closing.
      expect((await helpersOf(botId))[0]?.status).toBe("stopped");
    } finally {
      release();
      await stopping;
    }
  });

  it("is what a Ban does to the user's Helpers: the Screen closes and no report comes", async () => {
    const { deps, user, botId, computerFake } = await waitingHelper();

    await deps.bots.stopTurns({ userId: user.id });

    expect((await helpersOf(botId)).map((row) => row.status)).toEqual(["stopped"]);
    await expect
      .poll(() => screenCommands(computerFake).at(-1), { timeout: 10_000 })
      .toBe("/usr/local/bin/ai-chat-screen stop 1");
    expect(
      await getTestDb().select().from(botTrigger).where(eq(botTrigger.source, "helper")),
    ).toEqual([]);
  });

  it("never closes the Screen once another Helper of the user holds its slot", async () => {
    const { client, deps, user, helper, botId, computerFake } = await waitingHelper();
    const before = screenCommands(computerFake).length;

    // The next Helper takes the slot the stop freed as `start_helper` does: under the slot's lock,
    // which the stopped Helper's `bot.helper.stopped` job waits for before it looks for a holder.
    await getTestDb().transaction(async (tx) => {
      await lockScreen(tx, user.id, 1);
      await client.helpers.stop({ botId, helperId: helper.id });
      await expect.poll(() => waitingForScreenLock(user.id, 1), { timeout: 10_000 }).toBe(1);
      await tx.insert(botHelper).values({
        id: uuidv7(),
        botId,
        type: "computer_use",
        task: "Next.",
        status: "running",
        startedByTurnId: helper.startedByTurnId,
        screen: 1,
        startedAt: new Date(),
      });
    });
    await expect
      .poll(
        async () =>
          (
            await getTestDb()
              .select({ status: job.status })
              .from(job)
              .where(eq(job.idempotencyKey, `helper-stopped:${helper.id}`))
          )[0]?.status,
        { timeout: 10_000 },
      )
      .toBe("succeeded");

    // The stopped Helper's own job, late to see its cancel, closes its Screen as it ends.
    await closeScreen(deps, { id: helper.id, userId: user.id, screen: 1 });

    expect(screenCommands(computerFake).slice(before)).toEqual([]);
  }, 30_000);

  it("makes the next Helper wait out a close already under way, so the close never lands on it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let closing = false;
    const { client, user, helper, botId, computerFake } = await waitingHelper(
      async ({ command }) => {
        if (command.endsWith("ai-chat-screen stop 1")) {
          closing = true;
          await held;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      { nextHelper: true },
    );
    await client.helpers.stop({ botId, helperId: helper.id });
    // The close is past its look for a holder, and its `stop` is still running.
    await expect.poll(() => closing, { timeout: 10_000 }).toBe(true);

    const nextTurn = (async () => {
      for await (const _event of await followSend(client, { botId, id: uuidv7(), text: "next" }));
    })();
    try {
      await expect.poll(() => waitingForScreenLock(user.id, 1), { timeout: 10_000 }).toBe(1);
      expect(await helpersOf(botId)).toHaveLength(1);
    } finally {
      release();
    }
    await nextTurn;

    await expect
      .poll(async () => (await helpersOf(botId))[1]?.status, { timeout: 10_000 })
      .toBe("waiting");
    expect((await helpersOf(botId))[1]?.screen).toBe(1);
    // After that one close, the next Helper's Screen only ever opens.
    const commands = screenCommands(computerFake);
    const afterClose = commands.slice(commands.indexOf("/usr/local/bin/ai-chat-screen stop 1") + 1);
    expect(new Set(afterClose)).toEqual(
      new Set([`/usr/local/bin/ai-chat-screen start 1 ${botId}`]),
    );
  }, 30_000);
});

describe("bot.screen.control", () => {
  it("switches the Screen's x11vnc between control and view-only", async () => {
    const { client, helper, computerFake } = await waitingHelper();

    await client.computer.control({ helperId: helper.id, mode: "control" });
    await client.computer.control({ helperId: helper.id, mode: "view" });

    expect(screenCommands(computerFake).slice(-2)).toEqual([
      "/usr/local/bin/ai-chat-screen control 1",
      "/usr/local/bin/ai-chat-screen view 1",
    ]);
  });
});

describe("bot.helper.done", () => {
  it("makes the Screen view-only again, even when the user's client didn't give control back", async () => {
    const { client, helper, computerFake } = await waitingHelper();
    await client.computer.control({ helperId: helper.id, mode: "control" });

    await client.helpers.done({ helperId: helper.id });

    await expect
      .poll(() => screenCommands(computerFake).at(-1))
      .toBe("/usr/local/bin/ai-chat-screen view 1");
  });
});

describe("the live view's proxy", () => {
  it("serves the noVNC page and its files from the Screen, adding the traffic token upstream", async () => {
    const { client, deps, helper, novnc, computerFake } = await waitingHelper();
    const { url } = await client.computer.view({ helperId: helper.id });
    const handler = screenHandlerOf(deps);
    const asked = () => computerFake.callsOf("endpoint").length;
    const askedByLink = asked();

    const page = await handler(pageRequest(url));
    const file = await handler(pageRequest(url.replace(/vnc\.html.*$/, "app/ui.js")));

    expect(page.status).toBe(200);
    // The sandbox wrote it, so it runs in an opaque origin, not the Host's.
    expect(page.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    const html = await page.text();
    expect(html).toContain("noVNC /vnc.html?");
    // The storage shim is first in the head, before any noVNC script; only HTML gets it.
    expect(html).toMatch(/<head><script>.*localStorage.*sessionStorage.*<\/script><title>/);
    expect(html.match(/<script>/g)).toHaveLength(1);
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
    const { url } = await client.computer.view({ helperId: helper.id });
    const base = url.split("/vnc.html")[0]!;
    const handler = screenHandlerOf(deps);

    const within = await handler(pageRequest(`${base}/redirect?to=/vnc.html%3Fa%3D1`));
    const away = await handler(pageRequest(`${base}/redirect?to=https://elsewhere.example/`));

    expect(within.status).toBe(302);
    expect(within.headers.get("location")).toBe(`${base}/vnc.html?a=1`);
    expect(away.status).toBe(302);
    expect(away.headers.get("location")).toBeNull();
  });

  it("answers 502 when the Screen can't be reached, on the page and the socket alike", async () => {
    const { client, deps, helper, computerFake, offset } = await waitingHelper();
    const { url } = await client.computer.view({ helperId: helper.id });
    // A minute on, past the reused address, the sandbox is gone and its rebuild has no Screen open.
    offset.ms = minuteMs;
    computerFake.lose(sandboxOf(computerFake).sandboxId);

    expect((await screenHandlerOf(deps)(pageRequest(url))).status).toBe(502);
    await expect(screenSocketOf(deps).upgrade(socketRequest(url))).rejects.toMatchObject({
      status: 502,
    });
  });

  it("answers 403 without a valid view token, and reaches nothing upstream", async () => {
    const { client, deps, helper, novnc, offset } = await waitingHelper();
    const { url } = await client.computer.view({ helperId: helper.id });
    const token = url.split("/")[4]!;
    const handler = screenHandlerOf(deps);
    const forged = `${token.slice(0, -2)}${token.at(-2) === "A" ? "B" : "A"}${token.slice(-1)}`;

    const refused = [
      await handler(pageRequest("/api/chat/screens/vnc.html")),
      await handler(pageRequest(url.replace(token, "not-a-token"))),
      await handler(pageRequest(url.replace(token, forged))),
    ];
    // Ten minutes on, the link has expired.
    offset.ms = 11 * minuteMs;
    refused.push(await handler(pageRequest(url)));

    expect(refused.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    await expect(screenSocketOf(deps).upgrade(socketRequest(url))).rejects.toMatchObject({
      status: 403,
    });
    expect(novnc.requests).toEqual([]);
    expect(novnc.upgrades).toEqual([]);
  });

  it("refuses a path that leaves noVNC's directory, on the page and the socket, and reaches nothing", async () => {
    const { client, deps, helper, novnc } = await waitingHelper();
    const elsewhere = await fakeNovnc();
    cleanups.push(() => elsewhere.close());
    const { url } = await client.computer.view({ helperId: helper.id });
    const base = url.split("/vnc.html")[0]!;
    const host = new URL(elsewhere.origin).host;
    const escapes = [
      `${base}//${host}/latest/meta-data`,
      `${base}/${elsewhere.origin}/latest/meta-data`,
      `${base}/%2F%2F${host}/latest/meta-data`,
      `${base}/%2f%2f${host}/websockify`,
      `${base}/..%2F..%2Flatest`,
      `${base}/app/..%2F..%2Fwebsockify`,
      `${base}/%5C%5C${host}/latest`,
      `${base}/app/../../latest`,
      `${base}/%2e%2e/latest`,
    ];
    const screenHandler = screenHandlerOf(deps);
    const screenSocket = screenSocketOf(deps);

    const statuses = [];
    for (const path of escapes) {
      statuses.push((await screenHandler(pageRequest(path))).status);
      statuses.push(
        await screenSocket.upgrade(pageRequest(path)).then(
          () => 101,
          (refused: Response) => refused.status,
        ),
      );
    }

    expect(statuses.filter((status) => status < 400 || status >= 500)).toEqual([]);
    expect(elsewhere.requests).toEqual([]);
    expect(novnc.requests).toEqual([]);
    expect(novnc.upgrades).toEqual([]);
  });

  it("proxies the socket to websockify with the traffic token and the Screen's token, both ways", async () => {
    const { client, deps, helper, novnc, computerFake } = await waitingHelper();
    const { url } = await client.computer.view({ helperId: helper.id });
    const hooks = screenSocketOf(deps);

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
    const { url } = await client.computer.view({ helperId: helper.id });
    const hooks = screenSocketOf(deps);
    const { peer } = fakePeer((await hooks.upgrade(socketRequest(url))).context);
    hooks.open(peer);
    await expect.poll(() => novnc.upgrades.length).toBe(1);

    await novnc.close();

    await expect.poll(() => peer.closed).toBe(true);
  });

  it("counts the open live view as Computer activity, and stops once it closes", async () => {
    const { client, deps, helper, offset, user } = await waitingHelper();
    const { url } = await client.computer.view({ helperId: helper.id });
    const hooks = screenSocketOf(deps);
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
      }, beatTimeout);

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
    const { url } = await client.computer.view({ helperId: helper.id });
    const hooks = screenSocketOf(deps);
    const { peer } = fakePeer((await hooks.upgrade(socketRequest(url))).context);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      hooks.open(peer);
      await client.helpers.stop({ botId, helperId: helper.id });

      await vi.advanceTimersByTimeAsync(minuteMs);

      await vi.waitFor(() => expect(peer.closed).toBe(true), beatTimeout);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sdk.computer, called in-process with a userId (#897)", () => {
  it("gives a live-view link and switches control as the HTTP twins do", async () => {
    const { deps, client, helper, user, computerFake } = await waitingHelper();
    const userId = user.id;
    // The in-process methods are the instance's `computer`; the context holds them as `screens`.
    const screens = deps.screens;

    const { url } = await screens.view({ userId, helperId: helper.id });

    expect(url).toMatch(/^\/api\/chat\/screens\/[^/]+\/vnc\.html\?/);
    expect(Object.keys(await client.computer.view({ helperId: helper.id }))).toEqual(["url"]);
    await screens.control({ userId, helperId: helper.id, mode: "control" });
    await screens.control({ userId, helperId: helper.id, mode: "view" });
    expect(screenCommands(computerFake).slice(-2)).toEqual([
      "/usr/local/bin/ai-chat-screen control 1",
      "/usr/local/bin/ai-chat-screen view 1",
    ]);
  }, 30_000);

  it("finds no Helper of another user's", async () => {
    const { deps, helper } = await waitingHelper();
    const { id: userId } = await insertUser();

    await expect(deps.screens.view({ userId, helperId: helper.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      deps.screens.control({ userId, helperId: helper.id, mode: "control" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 30_000);
});
