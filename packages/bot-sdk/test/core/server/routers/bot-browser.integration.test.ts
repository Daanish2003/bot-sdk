import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnyTextAdapter, ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { botHelper, botTurn, computer as computerTable } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { snapshotLimit, staleRefError } from "../../../../plugins/bot/server/browser-tools";
import { rebuiltNote, spillPath } from "../../../../plugins/bot/server/computer-tools";
import {
  computerUseHelperPrompt,
  computerUseHelperTakenError,
  screensInUseError,
} from "../../../../plugins/bot/server/helper";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** A headless Chromium with its DevTools port open, as a Screen's Chrome is. */
type Chrome = { url: string; close: () => Promise<void> };

async function launchChrome(): Promise<Chrome> {
  const dir = await mkdtemp(join(tmpdir(), "screen-"));
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    args: ["--remote-debugging-port=0"],
    // Playwright's own Chromium when it is installed, else the machine's Chrome (as on CI).
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

const fixturePage = `<!doctype html><title>Fixture</title>
<h1>Hello</h1>
<label>Name <input></label>
<button onclick="document.querySelector('h1').textContent = 'Hi ' + document.querySelector('input').value">Greet</button>
<select aria-label="Colour"><option>red</option><option>blue</option></select>`;

const bigPage = `<!doctype html><title>Big</title><ul>${Array.from(
  { length: 1_500 },
  (_, i) => `<li>Item ${i} of a list that is far too long to read in one snapshot</li>`,
).join("")}</ul>`;

let server: Server;
let site: string;
let chrome: Chrome;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(request.url === "/big" ? bigPage : fixturePage);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await new Promise((resolve) => server?.close(resolve));
});

/** The runners the tests started, stopped after each test. */
const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) => String(prompt).startsWith("You are a Helper"));

/**
 * A user with an OpenAI key, over an SDK with `computer` on, whose fake provider points each
 * sandbox's DevTools ports at `chromeOf(sandboxId)`. The Turns play `turns` and the Helpers play
 * `helpers`; `beforeHelperCall` runs before the Helpers' n-th model call (from 0).
 */
async function userWith(
  turns: Round[],
  helpers: Round[],
  {
    chromeOf = () => chrome,
    manualHelpers = false,
    beforeHelperCall,
  }: {
    chromeOf?: (sandboxId: string) => Chrome;
    manualHelpers?: boolean;
    beforeHelperCall?: (index: number) => Promise<void>;
  } = {},
) {
  const turnFake = createFakeAdapter({ rounds: turns });
  const helperFake = createFakeAdapter({ rounds: helpers, manual: manualHelpers });
  let helperCalls = 0;
  const adapter = {
    ...turnFake.adapter,
    chatStream: async function* (options: TextOptions) {
      if (!isHelperCall(options)) return yield* turnFake.adapter.chatStream(options);
      await beforeHelperCall?.(helperCalls++);
      yield* helperFake.adapter.chatStream(options);
    },
  } as AnyTextAdapter;
  const computerFake = fakeComputerProvider({
    hostUrl: (sandboxId, port) =>
      port > 9222 ? chromeOf(sandboxId).url : `https://${port}-${sandboxId}.fake.test`,
  });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    deps: () => deps!,
  });
  deps = createTestSdk({
    plugins: [bot(), computer({ provider: computerFake.provider })],
    jobs,
    adapterFor: () => adapter,
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
  const newBot = async () => (await client.bot.create({ name: "Ada", model })).id;
  return { turnFake, helperFake, computerFake, deps, client, user, newBot };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, message: string) {
  for await (const _event of await client.bot.send({ botId, id: uuidv7(), text: message }));
}

const startComputerUse = (task: string) =>
  toolCall({ name: "start_helper", input: { type: "computer_use", task } });

const handsOff = (...calls: ReturnType<typeof toolCall>[]) =>
  round(...calls, toolCall({ name: "send_to_user", input: { text: "On it.", endTurn: true } }));

const browser = (name: string, input: object = {}) => toolCall({ name, input });

/** The last tool result in a model call's input, parsed. */
const lastResult = (options: TextOptions) => {
  const messages = options.messages as ModelMessage[];
  return JSON.parse(String(messages.findLast((entry) => entry.role === "tool")?.content));
};

/** The ref of the element whose snapshot line matches `pattern`, in the last tool result. */
const refIn = (options: TextOptions, pattern: string) => {
  const line = String(lastResult(options).snapshot)
    .split("\n")
    .find((entry) => entry.includes(pattern));
  const ref = line?.match(/\[ref=(\w+)\]/)?.[1];
  if (!ref) throw new Error(`No ref for ${pattern} in the snapshot`);
  return ref;
};

/** Each tool call of a transcript, with its parsed result, in order. */
const toolResults = (transcript: readonly ModelMessage[]) =>
  transcript
    .flatMap((entry) => entry.toolCalls ?? [])
    .map((call) => ({
      name: call.function.name,
      id: call.id,
      result: JSON.parse(
        String(transcript.find((entry) => entry.toolCallId === call.id)?.content ?? "null"),
      ),
    }));

const helpersOf = async (botId: string) =>
  getTestDb()
    .select()
    .from(botHelper)
    .where(eq(botHelper.botId, botId))
    .orderBy(asc(botHelper.startedAt), asc(botHelper.id));

async function ended(botId: string) {
  await expect
    .poll(async () => (await helpersOf(botId)).every((row) => row.status !== "running"), {
      timeout: 20_000,
    })
    .toBe(true);
  return (await helpersOf(botId))[0]!;
}

const screenScript = "/usr/local/bin/ai-chat-screen";

describe("a Computer-use Helper's browser", () => {
  it("opens its Screen, drives the page by ref, and closes the Screen when it ends", async () => {
    const { client, newBot, helperFake, computerFake } = await userWith(
      [handsOff(startComputerUse("Greet Ada on the fixture site.")), round()],
      [
        round(browser("browser_navigate", { url: site })),
        (options) =>
          round(browser("browser_type", { ref: refIn(options, 'textbox "Name"'), text: "Ada" })),
        (options) => round(browser("browser_click", { ref: refIn(options, 'button "Greet"') })),
        (options) =>
          round(
            browser("browser_select", {
              ref: refIn(options, 'combobox "Colour"'),
              values: ["blue"],
            }),
          ),
        round(browser("browser_snapshot")),
        round(text("The page now says Hi Ada.")),
      ],
    );
    const botId = await newBot();

    await send(client, botId, "greet Ada");
    const helper = await ended(botId);

    expect(helper).toMatchObject({
      type: "computer_use",
      status: "complete",
      screen: 1,
      report: "The page now says Hi Ada.",
    });
    expect(helperFake.calls[0]?.systemPrompts).toEqual([computerUseHelperPrompt]);
    expect((helperFake.calls[0]?.tools ?? []).map((tool) => tool.name)).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_select",
      "browser_press",
      "browser_tabs",
      "desktop",
      "ask_user",
    ]);
    const results = toolResults(helper.transcript ?? []);
    expect(results.map((call) => call.result.result)).toEqual([
      `Opened ${site}/`,
      expect.stringMatching(/^Typed into e\d+$/),
      expect.stringMatching(/^Clicked e\d+$/),
      expect.stringMatching(/^Selected blue in e\d+$/),
      undefined,
    ]);
    expect(results[0]?.result.snapshot).toContain(`- Page URL: ${site}/`);
    expect(results[0]?.result.snapshot).toContain('heading "Hello"');
    // Each action reads the page afresh.
    expect(results[2]?.result.snapshot).toContain('heading "Hi Ada"');
    expect(results[4]?.result.snapshot).toContain('option "blue" [selected]');
    // The Screen was opened on the Bot's profile before the first Step, and closed at the end.
    const commands = computerFake.callsOf("run").map((call) => call.command);
    expect(commands.filter((command) => command.startsWith(screenScript))).toEqual([
      `${screenScript} start 1 ${botId}`,
      `${screenScript} stop 1`,
    ]);
  }, 60_000);

  it("spills a snapshot over 20,000 characters to a file, returning its start and the path", async () => {
    const { client, newBot, computerFake } = await userWith(
      [handsOff(startComputerUse("Read the big page.")), round()],
      [round(browser("browser_navigate", { url: `${site}/big` })), round(text("Long."))],
    );
    const botId = await newBot();

    await send(client, botId, "read it");
    const helper = await ended(botId);

    const [navigate] = toolResults(helper.transcript ?? []);
    const path = spillPath(botId, navigate!.id);
    expect(navigate?.result.snapshotPath).toBe(path);
    const full = new TextDecoder().decode(computerFake.files.get(path));
    expect(full.length).toBeGreaterThan(snapshotLimit);
    expect(navigate?.result.snapshot.startsWith(full.slice(0, snapshotLimit))).toBe(true);
    expect(navigate?.result.snapshot.length).toBeLessThan(snapshotLimit + 100);
  }, 60_000);

  it("reopens the Screen after a lost sandbox, adds the rebuild note, and a ref from before is stale", async () => {
    const lostChrome = await launchChrome();
    let lost: string | undefined;
    const { client, newBot, computerFake, user } = await userWith(
      [handsOff(startComputerUse("Greet Ada.")), round()],
      [
        round(browser("browser_navigate", { url: site })),
        (options) => round(browser("browser_click", { ref: refIn(options, 'button "Greet"') })),
        round(text("Lost my place.")),
      ],
      {
        chromeOf: (sandboxId) => (sandboxId === lost || lost === undefined ? lostChrome : chrome),
        beforeHelperCall: async (index) => {
          if (index !== 1) return;
          // The sandbox is lost between two Steps, and its Chrome with it.
          lost = computerFake.callsOf("create")[0]!.sandboxId;
          computerFake.lose(lost);
          await lostChrome.close();
          // The server's connection notices the drop before the next tool call.
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
      },
    );
    const botId = await newBot();

    await send(client, botId, "greet Ada");
    const helper = await ended(botId);

    const [, click] = toolResults(helper.transcript ?? []);
    const [row] = await getTestDb()
      .select()
      .from(computerTable)
      .where(eq(computerTable.userId, user.id));
    expect(click?.result).toEqual({
      error: staleRefError,
      note: rebuiltNote({ rebuiltAt: row!.rebuiltAt!, restoredAsOf: null }),
    });
    const [, rebuilt] = computerFake.callsOf("create");
    const starts = computerFake
      .callsOf("run")
      .filter((call) => call.command.startsWith(`${screenScript} start`));
    expect(starts.map((call) => [call.sandboxId, call.command])).toEqual([
      [lost, `${screenScript} start 1 ${botId}`],
      [rebuilt?.sandboxId, `${screenScript} start 1 ${botId}`],
    ]);
  }, 60_000);
});

describe("starting a Computer-use Helper", () => {
  it("allows one per Bot and four Screens across the user's Bots, on the lowest free slots", async () => {
    const { client, newBot } = await userWith(
      [
        handsOff(startComputerUse("First."), startComputerUse("Second.")),
        handsOff(startComputerUse("Third.")),
        handsOff(startComputerUse("Fourth.")),
        handsOff(startComputerUse("Fifth.")),
        handsOff(startComputerUse("Sixth.")),
      ],
      // The Helpers keep running: their model calls wait until the test ends.
      Array.from({ length: 8 }, () => round(text("never"))),
      { manualHelpers: true },
    );
    const bots = [await newBot(), await newBot(), await newBot(), await newBot(), await newBot()];

    for (const botId of bots) await send(client, botId, "browse");

    const screens = await Promise.all(
      bots.map(async (botId) => (await helpersOf(botId)).map((row) => row.screen)),
    );
    expect(screens).toEqual([[1], [2], [3], [4], []]);
    const refusals = await Promise.all(
      bots.map(async (botId) => {
        const [turn] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
        return toolResults(turn?.transcript ?? [])
          .filter((call) => call.name === "start_helper" && "error" in call.result)
          .map((call) => call.result.error);
      }),
    );
    expect(refusals).toEqual([[computerUseHelperTakenError], [], [], [], [screensInUseError]]);
  }, 60_000);

  it("frees a Screen once its Helper ends, and a waiting Helper still holds one", async () => {
    const { client, newBot } = await userWith(
      [
        handsOff(startComputerUse("First.")),
        handsOff(startComputerUse("Second.")),
        handsOff(startComputerUse("Third.")),
      ],
      Array.from({ length: 4 }, () => round(text("never"))),
      { manualHelpers: true },
    );
    const [first, second, third] = [await newBot(), await newBot(), await newBot()];
    await send(client, first, "browse");
    await send(client, second, "browse");
    const setStatus = (botId: string, status: "complete" | "waiting") =>
      getTestDb().update(botHelper).set({ status }).where(eq(botHelper.botId, botId));
    await setStatus(first, "waiting");
    await setStatus(second, "complete");

    await send(client, third, "browse");

    expect((await helpersOf(third))[0]?.screen).toBe(2);
  }, 60_000);

  it("closes its Screen when it's stopped, which frees the slot (#591)", async () => {
    const { client, newBot, computerFake } = await userWith(
      [handsOff(startComputerUse("First.")), handsOff(startComputerUse("Second."))],
      Array.from({ length: 4 }, () => round(text("never"))),
      { manualHelpers: true },
    );
    const first = await newBot();
    await send(client, first, "browse");
    const commands = () =>
      computerFake
        .callsOf("run")
        .map((call) => call.command)
        .filter((command) => command.startsWith(screenScript));
    await expect.poll(commands, { timeout: 10_000 }).toEqual([`${screenScript} start 1 ${first}`]);

    await client.bot.helper.stop({ botId: first });

    // A job closes it once the stop has committed.
    await expect
      .poll(commands, { timeout: 10_000 })
      .toEqual([`${screenScript} start 1 ${first}`, `${screenScript} stop 1`]);
    const second = await newBot();
    await send(client, second, "browse");
    expect((await helpersOf(second))[0]?.screen).toBe(1);
  }, 60_000);
});
