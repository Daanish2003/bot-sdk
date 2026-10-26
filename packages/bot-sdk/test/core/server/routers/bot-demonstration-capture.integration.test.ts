import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo, connect, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asc, eq } from "drizzle-orm";
import { type Browser, chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  botDemonstration,
  botDemonstrationEvent,
  postgresBlobStore,
} from "../../../../core/server/storage";
import type { BlobStore } from "../../../../core/server/storage";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { deleteUserData } from "../../../../core/server/user-data";
import {
  demonstrationEventLimit,
  maskedValue,
} from "../../../../plugins/bot/server/demonstrations";
import { saveCredentials } from "../../../../plugins/models/server/internal";
import { inProcessRunner, type JobRunner } from "../../../../plugins/runner/server/internal";
import { skills } from "../../../../plugins/skills/server/plugin";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../support/fake-computer-provider";
import { followSend } from "../../../support/follow-send";

// Capture (spec #713, ticket #719): while a Demonstration records, the user's steps in the Screen's
// Chrome reach the server over its CDP connection, each with a screenshot. Run against a real
// headless Chromium, as the Browser tools' test does.

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const poll = { timeout: 10_000 };

/**
 * A headless Chromium with its DevTools port open, as a Screen's Chrome is. The capture reaches it
 * at `proxied`, a relay whose connections `cut` drops, as a network blip or a round's end does.
 */
type Chrome = { url: string; proxied: string; cut: () => void; close: () => Promise<void> };

async function launchChrome(): Promise<Chrome> {
  const dir = await mkdtemp(join(tmpdir(), "screen-"));
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    args: ["--remote-debugging-port=0"],
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" }),
  });
  let port: string | undefined;
  for (let tries = 0; !port; tries += 1) {
    port = await readFile(join(dir, "DevToolsActivePort"), "utf8").then(
      (file) => file.split("\n")[0],
      () => undefined,
    );
    if (!port && tries > 100) throw new Error("Chromium's DevTools port did not open");
    if (!port) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const sockets = new Set<Socket>();
  const relay = createTcpServer((socket) => {
    const upstream = connect(Number(port), "127.0.0.1");
    for (const end of [socket, upstream]) {
      sockets.add(end);
      end.on("close", () => sockets.delete(end));
      end.on("error", () => {});
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    proxied: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`,
    cut: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      relay.close();
      for (const socket of sockets) socket.destroy();
      await context.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const html = (title: string, body: string) => `<!doctype html><title>${title}</title>${body}`;

function serve(pages: (host: string) => Record<string, string>): Promise<Server> {
  const server = createServer((request, response) => {
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = pages(host)[request.url ?? "/"];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html" });
    response.end(page ?? "");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let site: Server;
let other: Server;
let origin: string;
let otherOrigin: string;
let chrome: Chrome;

beforeAll(async () => {
  other = await serve(() => ({
    "/frame": html("Other", `<button id="cross">Cross frame</button>`),
  }));
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  site = await serve(() => ({
    "/": html(
      "Payouts",
      `<button id="go" aria-label="Go now">Go</button>
      <label>Name <input id="name"></label>
      <input id="pw" type="password" aria-label="Password">
      <select aria-label="Colour"><option>red</option><option>blue</option></select>
      <a id="next" href="/next">Next</a>
      <input id="secret" type="password" aria-label="Secret">
      <button id="show" onclick="document.getElementById('secret').type = 'text'">Show</button>
      <label><input id="remember" type="checkbox"> <span id="remember-text">Remember me</span></label>`,
    ),
    "/next": html("Next", `<button>Second</button>`),
    "/frames": html(
      "Frames",
      `<iframe src="/frame"></iframe><iframe src="${otherOrigin}/frame"></iframe>`,
    ),
    "/frame": html("Same", `<button id="same">Same frame</button>`),
  }));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise((resolve) => site?.close(resolve));
  await new Promise((resolve) => other?.close(resolve));
});

const started: JobRunner[] = [];
/** The test's own connection, the user's hands on the Screen. */
let hands: Browser | undefined;

beforeEach(async () => {
  chrome = await launchChrome();
}, 60_000);

afterEach(async () => {
  puts.held = undefined;
  puts.started = 0;
  await hands?.close().catch(() => {});
  hands = undefined;
  for (const jobs of started.splice(0)) await jobs.stop();
  await chrome?.close();
});

const watchUser = toolCall({
  name: "run_tool",
  input: { name: "watch_user", args: { goal: "Copy the payouts", inputs: ["the week"] } },
});
const ends = toolCall({ name: "send_to_user", input: { text: "Go ahead.", endTurn: true } });

/**
 * A Bot whose Turn starts a Demonstration on its Screen, whose Chrome is `chrome`, with a page of
 * the test's site already open in it, as the user's tab is. Resolves once the capture is set up,
 * which its first step, the open page's navigation, shows.
 */
async function demonstrating(path = "/") {
  const fake = createFakeAdapter({ rounds: [round(watchUser, ends)] });
  const computerFake = fakeComputerProvider({
    hostUrl: (sandboxId, port) =>
      port > 9222 ? chrome.proxied : `https://${port}-${sandboxId}.fake.test`,
  });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    features: [skills()],
    jobs,
    adapterFor: () => fake.adapter,
    memory: false,
    blobStore: slowPuts(postgresBlobStore(getTestDb())),
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const botId = (await client.bot.create({ name: "Ada", model })).id;

  hands = await chromium.connectOverCDP(chrome.url);
  const context = hands.contexts()[0]!;
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${origin}${path}`);

  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: "watch me" }));
  const [row] = await getTestDb()
    .select({ id: botDemonstration.id })
    .from(botDemonstration)
    .where(eq(botDemonstration.botId, botId));
  const demonstrationId = row!.id;
  await expect
    .poll(async () => (await eventsOf(demonstrationId)).map((event) => event.kind), poll)
    .toEqual(["navigation"]);
  return { deps: deps!, client, user, botId, demonstrationId, page };
}

/**
 * A gate a test closes to hold every screenshot's put until it opens it, and how many puts have
 * reached it.
 */
const puts = { held: undefined as Promise<void> | undefined, started: 0 };

/**
 * `store` with each put taking a while, as a remote blob store's does: a step's row must never be
 * read before its screenshot's bytes are there. A put waits at `puts.held` too.
 */
const slowPuts = (store: BlobStore): BlobStore => ({
  ...store,
  put: async (...args) => {
    puts.started += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await puts.held;
    await store.put(...args);
  },
});

/** Holds every put until the returned function is called. */
function holdPuts(): () => void {
  let open!: () => void;
  puts.held = new Promise((resolve) => {
    open = resolve;
  });
  return open;
}

const eventsOf = (demonstrationId: string) =>
  getTestDb()
    .select()
    .from(botDemonstrationEvent)
    .where(eq(botDemonstrationEvent.demonstrationId, demonstrationId))
    .orderBy(asc(botDemonstrationEvent.sequence));

const pngSignature = [0x89, 0x50, 0x4e, 0x47];

describe("capturing a Demonstration", () => {
  it("records each step with its URL, label, selector and value, and a screenshot", async () => {
    const { deps, client, user, botId, demonstrationId, page } = await demonstrating();

    await page.locator("#go").click();
    await page.locator("#name").fill("Ada Lovelace");
    await page.locator("#name").press("Enter");
    await page.locator("select").selectOption("blue");

    await expect
      .poll(async () => (await eventsOf(demonstrationId)).length, poll)
      .toBeGreaterThanOrEqual(5);
    const events = await eventsOf(demonstrationId);
    expect(
      events.map(({ sequence, kind, url, label, selector, value }) => ({
        sequence,
        kind,
        url,
        label,
        selector,
        value,
      })),
    ).toEqual([
      {
        sequence: 1,
        kind: "navigation",
        url: `${origin}/`,
        label: "Payouts",
        selector: null,
        value: null,
      },
      {
        sequence: 2,
        kind: "click",
        url: `${origin}/`,
        label: "Go now",
        selector: "#go",
        value: null,
      },
      {
        sequence: 3,
        kind: "input",
        url: `${origin}/`,
        label: "Name",
        selector: "#name",
        value: "Ada Lovelace",
      },
      {
        sequence: 4,
        kind: "key",
        url: `${origin}/`,
        label: "Name",
        selector: "#name",
        value: "Enter",
      },
      {
        sequence: 5,
        kind: "change",
        url: `${origin}/`,
        label: "Colour",
        selector: 'select[aria-label="Colour"]',
        value: "blue",
      },
    ]);
    for (const event of events) {
      expect(event.offsetMs).toBeGreaterThanOrEqual(0);
      const png = await deps.blobStore.get(event.screenshotKey!);
      expect([...png!.subarray(0, 4)]).toEqual(pngSignature);
    }

    // The card counts the steps, and the user reads them back.
    const { messages } = await client.bot.get({ botId });
    expect(
      messages.find((message) => message.control?.kind === "demonstration")?.control,
    ).toMatchObject({ steps: 5 });
    const { steps } = await client.bot.demonstration.steps({ demonstrationId });
    expect(steps.map((step) => [step.kind, step.label, step.value])).toEqual([
      ["navigation", "Payouts", null],
      ["click", "Go now", null],
      ["input", "Name", "Ada Lovelace"],
      ["key", "Name", "Enter"],
      ["change", "Colour", "blue"],
    ]);

    // The screenshots go with their user.
    await client.bot.demonstration.cancel({ demonstrationId });
    await deleteUserData(deps, user.id);
    for (const event of events) expect(await deps.blobStore.get(event.screenshotKey!)).toBeNull();
  }, 60_000);

  it("never sends a password, and takes no screenshot of it", async () => {
    const { deps, demonstrationId, page } = await demonstrating();

    await page.locator("#pw").fill("hunter2");
    await page.locator("#go").click();

    await expect
      .poll(async () => (await eventsOf(demonstrationId)).map((event) => event.kind), poll)
      .toEqual(["navigation", "input", "click"]);
    const events = await eventsOf(demonstrationId);
    expect(events[1]).toMatchObject({
      label: "Password",
      selector: "#pw",
      value: maskedValue,
      screenshotKey: null,
    });
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(await deps.blobStore.get(events[2]!.screenshotKey!)).not.toBeNull();
  }, 60_000);

  it("keeps a password masked once its field is shown as text", async () => {
    const { demonstrationId, page } = await demonstrating();

    await page.locator("#secret").fill("hunter2");
    await page.locator("#show").click();
    await page.locator("#secret").fill("hunter2!");
    await page.locator("#go").click();

    await expect
      .poll(async () => (await eventsOf(demonstrationId)).map((event) => event.kind), poll)
      .toEqual(["navigation", "input", "click", "input", "click"]);
    const events = await eventsOf(demonstrationId);
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(events[3]).toMatchObject({ value: maskedValue, screenshotKey: null });
    // No screenshot while the page shows the password: the Show click's, and every step's after.
    expect(events.map((event) => event.screenshotKey === null)).toEqual([
      false,
      true,
      true,
      true,
      true,
    ]);
  }, 60_000);

  it("records a click on a label as one click on its control", async () => {
    const { demonstrationId, page } = await demonstrating();

    await page.locator("#remember-text").click();

    await expect
      .poll(
        async () =>
          (await eventsOf(demonstrationId)).map(({ kind, selector, value }) => [
            kind,
            selector,
            value,
          ]),
        poll,
      )
      .toEqual([
        ["navigation", null, null],
        ["click", "#remember", null],
        ["change", "#remember", "true"],
      ]);
  }, 60_000);

  it("captures nothing while paused, and marks the gap", async () => {
    const { deps, client, demonstrationId, page } = await demonstrating();

    await client.bot.demonstration.pause({ demonstrationId });
    await page.locator("#name").fill("secret code");
    await page.locator("#go").click();
    await page.waitForTimeout(1_500);
    await client.bot.demonstration.resume({ demonstrationId });
    await page.locator("#go").click();

    await expect
      .poll(async () => (await eventsOf(demonstrationId)).map((event) => event.kind), poll)
      .toEqual(["navigation", "pause", "click"]);
    const events = await eventsOf(demonstrationId);
    expect(JSON.stringify(events)).not.toContain("secret code");
    expect(events[1]).toMatchObject({ url: null, screenshotKey: null });
    // The blobs are the navigation's and the click's only.
    const keys = events.flatMap((event) => event.screenshotKey ?? []);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(await deps.blobStore.get(key)).not.toBeNull();
  }, 60_000);

  it("drops a step taken while paused, even one stored after Resume", async () => {
    const { client, demonstrationId, page } = await demonstrating();
    const open = holdPuts();
    await page.locator("#go").click();
    await expect.poll(() => puts.started, poll).toBe(2);

    // Taken while paused, and queued behind the held step until after the Resume.
    await client.bot.demonstration.pause({ demonstrationId });
    await page.locator("#name").click();
    await page.waitForTimeout(500);
    await client.bot.demonstration.resume({ demonstrationId });
    open();
    await page.locator("#go").click();

    await expect
      .poll(
        async () => (await eventsOf(demonstrationId)).map(({ kind, selector }) => [kind, selector]),
        poll,
      )
      .toEqual([
        ["navigation", null],
        ["pause", null],
        ["click", "#go"],
        ["click", "#go"],
      ]);
  }, 60_000);

  it("keeps a step taken while the capture reconnects", async () => {
    const { demonstrationId, page } = await demonstrating();

    chrome.cut();
    await page.waitForTimeout(500);
    await page.locator("#go").click();

    await expect
      .poll(
        async () => (await eventsOf(demonstrationId)).map(({ kind, selector }) => [kind, selector]),
        { timeout: 30_000 },
      )
      .toEqual([
        ["navigation", null],
        ["click", "#go"],
      ]);
  }, 60_000);

  it("stores a step its page sends twice once", async () => {
    const { demonstrationId, page } = await demonstrating();
    const binding = `__botDemonstration_${demonstrationId.replaceAll("-", "")}`;

    // As when a round took a step but its answer never reached the page, which sent it again.
    await page.evaluate(
      async ({ name, id }) => {
        const step = { id, kind: "click", url: location.href, label: "Go", selector: "#go" };
        const report = (window as unknown as Record<string, (step: object) => Promise<void>>)[
          name
        ]!;
        await report({ ...step, value: null, masked: false });
        await report({ ...step, value: null, masked: false });
      },
      { name: binding, id: randomUUID() },
    );
    await page.locator("#name").click();

    await expect
      .poll(
        async () => (await eventsOf(demonstrationId)).map(({ kind, selector }) => [kind, selector]),
        poll,
      )
      .toEqual([
        ["navigation", null],
        ["click", "#go"],
        ["click", "#name"],
      ]);
  }, 60_000);

  it("keeps listening after a navigation, in a new tab and in frames", async () => {
    const { demonstrationId, page } = await demonstrating();

    await page.locator("#next").click();
    await page.waitForURL("**/next");
    await page.getByRole("button", { name: "Second" }).click();
    const tab = await page.context().newPage();
    await tab.goto(`${origin}/frames`);
    await tab.frameLocator(`iframe[src="/frame"]`).locator("#same").click();
    await tab.frameLocator(`iframe[src="${otherOrigin}/frame"]`).locator("#cross").click();

    await expect
      .poll(
        async () =>
          (await eventsOf(demonstrationId)).map(({ kind, url, label }) => [kind, url, label]),
        poll,
      )
      .toEqual([
        ["navigation", `${origin}/`, "Payouts"],
        ["click", `${origin}/`, "Next"],
        ["navigation", `${origin}/next`, "Next"],
        ["click", `${origin}/next`, "Second"],
        ["navigation", `${origin}/frames`, "Frames"],
        ["click", `${origin}/frame`, "Same frame"],
        ["click", `${otherOrigin}/frame`, "Cross frame"],
      ]);
  }, 60_000);

  it(`ends as Done at ${demonstrationEventLimit} stored steps`, async () => {
    const { client, botId, demonstrationId, page } = await demonstrating();

    // Masked steps take no screenshot, so 200 of them are quick.
    await page.locator("#pw").focus();
    for (let i = 0; i < demonstrationEventLimit + 5; i += 1) await page.keyboard.press("Enter");

    await expect
      .poll(async () => {
        const [row] = await getTestDb()
          .select({ state: botDemonstration.state })
          .from(botDemonstration)
          .where(eq(botDemonstration.id, demonstrationId));
        return row?.state;
      }, poll)
      .toBe("drafting");
    await page.waitForTimeout(500);
    expect(await eventsOf(demonstrationId)).toHaveLength(demonstrationEventLimit);
    const { messages } = await client.bot.get({ botId });
    expect(
      messages.find((message) => message.control?.kind === "demonstration")?.control,
    ).toMatchObject({
      steps: demonstrationEventLimit,
    });
  }, 90_000);
});
