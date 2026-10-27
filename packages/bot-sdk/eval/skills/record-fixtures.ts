import { sendAndFollow } from "../../test/support/follow-send";
// Records the drafting-pass eval's fixture Demonstrations (spec #713, ticket #721), once, by hand:
// `pnpm -F @ai-chat/bot-sdk eval:skills:record`. Each fixture is scripted browser steps on a small
// local site, captured by the real capture code (#719) against a real local Chromium, as
// bot-demonstration-capture.integration.test.ts does. They did NOT come from the real Computer:
// there is no E2B here, so Chromium stands in for the Screen's Chrome. The result is checked in
// under eval/skills/fixtures/<id>/ (events.json and one PNG per screenshot); this script only needs
// running again if the capture changes. The local site's address is rewritten to a made-up host.

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { asc, eq } from "drizzle-orm";
import { type Page, chromium } from "playwright-core";

import { botDemonstration, botDemonstrationEvent } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { sendToUserToolName } from "@botsdk/bot/bot/context";
import { skills } from "@botsdk/skills";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import { createFakeAdapter, round, toolCall } from "../../test/support/fake-adapter";
import { fakeComputerProvider } from "../../test/support/fake-computer-provider";
import type { RecordedFixture } from "./fixtures";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { freshBot, type TurnEnv } from "../turn/case";

const here = fileURLToPath(new URL(".", import.meta.url));

const html = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:16px sans-serif;margin:24px}label,button,a{display:block;margin:10px 0}</style>${body}`;

/** One scripted fixture: a site, where the user starts, what they do, and how its address reads. */
type Script = {
  id: string;
  goal: string;
  inputs: string[];
  start: string;
  pages: Record<string, string>;
  /** The made-up address of a path on the local site. */
  address: (path: string) => string;
  /** The user's steps. */
  steps: (page: Page) => Promise<void>;
};

const scripts: Script[] = [
  {
    id: "payouts-to-sheet",
    goal: "Copy this week's payouts from the dashboard into the payouts sheet",
    inputs: ["the week"],
    start: "/payouts",
    address: (path) =>
      path.startsWith("/sheet")
        ? `https://sheets.example.com${path}`
        : `https://dashboard.example.com${path}`,
    pages: {
      "/payouts": html(
        "Payouts dashboard",
        `<h1>Payouts</h1>
        <label>Week <select aria-label="Week"><option>2026-W41</option><option>2026-W42</option></select></label>
        <button id="export">Export CSV</button>
        <a id="sheet" href="/sheet">Open the payouts sheet</a>`,
      ),
      "/sheet": html(
        "Payouts sheet",
        `<h1>Payouts sheet</h1>
        <label>Paste payouts <textarea id="rows" aria-label="Paste payouts"></textarea></label>
        <button id="save">Save sheet</button>`,
      ),
    },
    steps: async (page) => {
      await page.locator("select").selectOption("2026-W42");
      await page.locator("#export").click();
      await page.locator("#sheet").click();
      await page.locator("#rows").fill("1250,700,3025");
      await page.locator("#save").click();
    },
  },
  {
    id: "download-invoice",
    goal: "Download the latest invoice from the vendor portal",
    inputs: ["the month"],
    start: "/login",
    address: (path) => `https://billing.acme-vendor.example${path}`,
    pages: {
      "/login": html(
        "Vendor portal sign in",
        `<h1>Sign in</h1>
        <label>Email <input id="email" type="email"></label>
        <label>Password <input id="password" type="password"></label>
        <button id="signin" onclick="location.href='/invoices'">Sign in</button>`,
      ),
      "/invoices": html(
        "Invoices",
        `<h1>Invoices</h1>
        <label>Month <select aria-label="Month"><option>September</option><option>October</option></select></label>
        <button id="download" onclick="document.body.append('Downloaded')">Download invoice</button>`,
      ),
    },
    steps: async (page) => {
      await page.locator("#email").fill("billing@example.com");
      await page.locator("#password").fill("hunter2-not-a-real-password");
      await page.locator("#signin").click();
      await page.locator("select").selectOption("October");
      await page.locator("#download").click();
    },
  },
  {
    id: "book-meeting-room",
    goal: "Book a meeting room for my team",
    inputs: ["the room", "the date", "who is coming"],
    start: "/rooms",
    address: (path) => `https://rooms.example.com${path}`,
    pages: {
      "/rooms": html(
        "Book a room",
        `<h1>Book a room</h1>
        <label>Room <select aria-label="Room"><option>Atlas</option><option>Borealis</option></select></label>
        <label>Date <input id="date" aria-label="Date"></label>
        <label>Attendees <input id="people" aria-label="Attendees"></label>
        <button id="book" onclick="document.body.append('Booked')">Book room</button>`,
      ),
    },
    steps: async (page) => {
      await page.locator("select").selectOption("Borealis");
      await page.locator("#date").fill("2026-11-03");
      await page.locator("#people").fill("Sam, Priya, Lee");
      await page.locator("#book").click();
    },
  },
];

async function launchChrome() {
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
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await context.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function serve(pages: Record<string, string>): Promise<Server> {
  const server = createServer((request, response) => {
    const page = pages[request.url ?? "/"];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html" });
    response.end(page ?? "");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function record(script: Script, databaseUrl: string) {
  const site = await serve(script.pages);
  const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const chrome = await launchChrome();
  const fake = createFakeAdapter({
    rounds: [
      round(
        toolCall({
          name: "run_tool",
          input: {
            name: "watch_user",
            args: { goal: script.goal, inputs: script.inputs },
          },
        }),
        toolCall({ name: sendToUserToolName, input: { text: "Go ahead.", endTurn: true } }),
      ),
    ],
  });
  const db = await prepareSchema(databaseUrl);
  const computerFake = fakeComputerProvider({
    hostUrl: (sandboxId, port) =>
      port > 9222 ? chrome.url : `https://${port}-${sandboxId}.fake.test`,
  });
  const sdk = createComputerSdk({
    db,
    provider: computerFake.provider,
    features: [skills()],
    models: (real) => ({ ...real, adapterFor: () => fake.adapter }),
  });
  const jobs = runnerJobs(sdk);
  await jobs.start();
  const env: TurnEnv = {
    db,
    sdk,
    model: "openai:gpt-6-luna",
    credentialsFor: () => ({ apiKey: "sk-fake" }),
  };
  try {
    const { userId, bot: made } = await freshBot(env, script.id, 0);
    const hands = await chromium.connectOverCDP(chrome.url);
    const context = hands.contexts()[0]!;
    const page = context.pages()[0] ?? (await context.newPage());
    // Small screenshots keep the checked-in fixtures small.
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto(`${origin}${script.start}`);

    for await (const _ of await sendAndFollow(sdk, {
      userId,
      botId: made.id,
      id: uuidv7(),
      text: "let me show you",
    })) {
      // Drained: the Turn ends after it opens the Show me card.
    }
    const [row] = await db
      .select({ id: botDemonstration.id })
      .from(botDemonstration)
      .where(eq(botDemonstration.botId, made.id));
    if (!row) throw new Error("watch_user started no Demonstration");
    const eventsOf = () =>
      db
        .select()
        .from(botDemonstrationEvent)
        .where(eq(botDemonstrationEvent.demonstrationId, row.id))
        .orderBy(asc(botDemonstrationEvent.sequence));
    await waitFor(async () => (await eventsOf()).length >= 1);

    await script.steps(page);
    // Wait until the steps stop arriving.
    let last = -1;
    await waitFor(async () => {
      const count = (await eventsOf()).length;
      const settled = count === last && count > 1;
      last = count;
      return settled;
    }, 800);

    const events = await eventsOf();
    const directory = join(here, "fixtures", script.id);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const address = (url: string | null) =>
      url === null ? null : url.startsWith(origin) ? script.address(url.slice(origin.length)) : url;
    const recorded: RecordedFixture = { goal: script.goal, inputs: script.inputs, events: [] };
    for (const event of events) {
      let screenshot: string | null = null;
      if (event.screenshotKey) {
        const bytes = await sdk.blobStore.get(event.screenshotKey);
        if (bytes) {
          screenshot = `${String(event.sequence).padStart(2, "0")}.png`;
          await writeFile(join(directory, screenshot), bytes);
        }
      }
      recorded.events.push({
        sequence: event.sequence,
        offsetMs: event.offsetMs,
        kind: event.kind,
        url: address(event.url),
        label: event.label,
        selector: event.selector,
        value: event.value,
        screenshot,
      });
    }
    await writeFile(join(directory, "events.json"), JSON.stringify(recorded, null, 2) + "\n");
    console.log(`${script.id}: ${events.length} events recorded`);
    await hands.close().catch(() => {});
    // The capture job ends once its Demonstration does, so the runner can stop.
    await db
      .update(botDemonstration)
      .set({ state: "cancelled", endedAt: new Date() })
      .where(eq(botDemonstration.id, row.id));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } finally {
    await jobs.stop();
    await db.$client.end();
    await chrome.close();
    await new Promise((resolve) => site.close(resolve));
  }
}

async function waitFor(check: () => Promise<boolean>, everyMs = 200, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error("Timed out waiting for the capture");
}

for (const script of scripts) await record(script, databaseUrlFromEnv());
process.exit(0);
