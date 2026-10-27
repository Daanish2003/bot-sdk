// The Screen checks of the lifecycle eval (spec #587, #599): the live view's link and proxy against
// real noVNC, and that a Screen's displays and Chrome survive a pause and resume. The live view is
// loaded in a headless Chromium through the SDK's own screen handler and socket hooks, mounted on a
// throwaway HTTP server, because the proxy serves noVNC with `Content-Security-Policy: sandbox
// allow-scripts`, an opaque origin that nothing else checks against real noVNC.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { chromium } from "playwright-core";

import { botHelper, botTurn } from "@botsdk/bot/storage";
import type { Database } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { screenView } from "@botsdk/bot/bot/helpers";
import { createBot } from "@botsdk/bot/bot/conversation";
import type { ComputerHandle } from "@botsdk/bot/computer/internal";
import type { createComputerSdk } from "./setup";
import { acceptSocket } from "./ws-server";
import { createHttpHandlerOver, createScreenSocketOver } from "@botsdk/bot/over";

/** Where the throwaway server serves the HTTP layer. */
const basePath = "/api/chat";

type Sdk = ReturnType<typeof createComputerSdk>;

/** One line of the eval's output: a name, whether it held, and a detail. */
export type Check = (name: string, ok: boolean, detail?: string) => void;

const requestOf = (request: IncomingMessage, origin: string) =>
  new Request(`${origin}${request.url}`, {
    method: request.method,
    headers: Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ) as [string, string][],
  });

/**
 * Serves the SDK's live-view handler and socket hooks on a free port of localhost. `stripCsp` drops
 * the CSP header from the responses, for the diagnostic that tells whether the CSP is what stops
 * noVNC; the SDK itself is unchanged.
 */
async function serveLiveView(
  sdk: Sdk,
  options: { stripCsp?: boolean } = {},
): Promise<{ origin: string; server: Server }> {
  const screenHandler = createHttpHandlerOver(sdk, { basePath, getUser: () => null });
  const screenSocket = createScreenSocketOver(sdk, { basePath });
  let origin = "";
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const answer = await screenHandler(requestOf(request, origin));
    const headers = Object.fromEntries(answer.headers);
    if (options.stripCsp) delete headers["content-security-policy"];
    response.writeHead(answer.status, headers);
    if (answer.body) Readable.fromWeb(answer.body as never).pipe(response);
    else response.end();
  });
  server.on("upgrade", async (request, socket) => {
    try {
      const { protocol, context } = await screenSocket.upgrade(requestOf(request, origin));
      const accepted = acceptSocket(request, socket, protocol, {
        onMessage: (data) => screenSocket.message(peer, { uint8Array: () => data }),
        onClose: () => screenSocket.close(peer),
      });
      const peer = { context, send: accepted.send, close: accepted.close };
      screenSocket.open(peer);
    } catch (caught) {
      const status = caught instanceof Response ? caught.status : 500;
      socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, server };
}

/** A waiting Computer-use Helper of the user's on Screen `slot`, whose live view the link opens. */
async function waitingHelper(db: Database, userId: string, slot: number) {
  const now = new Date();
  const created = await createBot(db, userId, { name: "Eval", model: "openai:gpt-5.4-mini" }, now);
  const turnId = uuidv7();
  await db.insert(botTurn).values({
    id: turnId,
    botId: created.id,
    status: "complete",
    startedAt: now,
    endedAt: now,
    transcript: [],
  });
  const helperId = uuidv7();
  await db.insert(botHelper).values({
    id: helperId,
    botId: created.id,
    type: "computer_use",
    task: "Eval: hold a Screen.",
    status: "waiting",
    startedByTurnId: turnId,
    screen: slot,
    startedAt: now,
  });
  return { botId: created.id, helperId };
}

/** The proxy path of a live-view request up to its token, which a log line must not print. */
const screenToken = /^\/api\/chat\/screens\/[^/]+/;

type Loaded = {
  /** What noVNC showed once it connected, or null when it never did. */
  connected: { status: string; width: number } | null;
  status: string;
  problems: string[];
};

/**
 * Loads the live-view link in a headless Chromium and waits for noVNC to show the remote screen.
 */
async function tryLiveView(link: string, shot?: string) {
  const browser = await chromium.launch({ headless: true });
  const problems: string[] = [];
  try {
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console error: ${message.text()}`);
    });
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("requestfailed", (request) =>
      problems.push(
        `request failed: ${new URL(request.url()).pathname.replace(screenToken, "/api/chat/screens/<token>")} ${request.failure()?.errorText}`,
      ),
    );
    await page.goto(link);
    const connected = await page
      .waitForFunction(
        () => {
          const status = document.getElementById("noVNC_status")?.textContent ?? "";
          const canvas = document.querySelector<HTMLCanvasElement>("#noVNC_container canvas");
          return status.startsWith("Connected") || (canvas !== null && canvas.width >= 1280)
            ? { status, width: canvas?.width ?? 0 }
            : false;
        },
        undefined,
        { timeout: 30_000 },
      )
      .then(
        async (handle) => (await handle.jsonValue()) as { status: string; width: number },
        () => null,
      );
    if (shot) await page.screenshot({ path: shot }).catch(() => {});
    const status = await page
      .evaluate(() => document.getElementById("noVNC_status")?.textContent ?? "(no status)")
      .catch(() => "(page gone)");
    return { connected, status, problems } satisfies Loaded;
  } finally {
    await browser.close();
  }
}

/** Checks that noVNC connects through the proxy, and when it doesn't, says why and whether the CSP is the cause. */
async function loadLiveView(
  link: string,
  bareLink: string,
  check: Check,
  label: string,
  shot?: string,
) {
  const loaded = await tryLiveView(link, shot);
  const { connected } = loaded;
  check(
    `${label}: noVNC connects under the CSP sandbox`,
    connected !== null,
    connected ? `${connected.status || "canvas"}, framebuffer ${connected.width} px wide` : "",
  );
  if (connected !== null) return;
  console.log(`      noVNC status: ${loaded.status}`);
  for (const problem of loaded.problems.slice(0, 8)) console.log(`      ${problem}`);
  const without = await tryLiveView(bareLink);
  console.log(
    `      diagnostic, the same link with the CSP header stripped: noVNC ${without.connected ? `connects (${without.connected.status})` : `does not connect (${without.status})`}`,
  );
}

/** The pid files of Screen `slot`'s processes that no longer name a live process. */
const deadProcesses = async (computer: ComputerHandle, slot: number) => {
  const result = await computer.run(
    `for f in /tmp/screens/${slot}/*.pid; do kill -0 "$(cat $f)" 2>/dev/null || echo "dead $(basename $f)"; done; ls /tmp/screens/${slot}/*.pid | wc -l`,
    { timeoutMs: 15_000 },
  );
  if (!("stdout" in result)) return ["timed out"];
  const lines = result.stdout.trim().split("\n");
  const count = Number(lines.pop());
  return [...lines, ...(count === 4 ? [] : [`${count} pid files, expected 4`])];
};

/** Connects to the Screen's Chrome over CDP, retrying for up to `withinMs`, and returns the wait. */
async function connectChrome(computer: ComputerHandle, slot: number, withinMs: number) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < withinMs) {
    try {
      const { cdp } = await computer.screenUrls(slot);
      const browser = await chromium.connectOverCDP(cdp.url, {
        headers: cdp.headers,
        timeout: 10_000,
      });
      return { browser, waitedMs: Date.now() - started, error: "" };
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  return { browser: null, waitedMs: Date.now() - started, error: lastError };
}

/**
 * Opens Screen 1, loads its live view, and returns what step "pause and resume" needs: the Screen
 * is left open with a marker set in its Chrome page. `pause` pauses the Computer and returns once it
 * is asleep.
 */
export async function checkScreens(options: {
  sdk: Sdk;
  db: Database;
  userId: string;
  computer: ComputerHandle;
  check: Check;
  pause: () => Promise<void>;
  shotDirectory?: string;
}) {
  const { sdk, db, userId, computer, check, pause, shotDirectory } = options;
  const slot = 1;
  await computer.openScreen(slot, "eval");
  const urls = await computer.screenUrls(slot);

  // Upstream, the sandbox's own endpoint refuses a request without the traffic token.
  const novncPage = urls.novnc.url.split("?")[0]!;
  const { "e2b-traffic-access-token": _token, ...routing } = urls.novnc.headers;
  const noTraffic = await fetch(novncPage, { headers: routing });
  check(
    "noVNC refuses a request without the traffic token",
    noTraffic.status === 403,
    `HTTP ${noTraffic.status}`,
  );

  // A marker in Chrome's page, which only the same Chrome process still holds after the pause.
  const first = await connectChrome(computer, slot, 30_000);
  if (!first.browser) {
    check("Chrome answers over CDP", false, first.error);
    return;
  }
  const page =
    first.browser.contexts()[0]?.pages()[0] ?? (await first.browser.contexts()[0]!.newPage());
  await page.goto("data:text/html,<title>eval</title><p>eval page</p>");
  await page.evaluate(() => {
    (window as unknown as { evalMarker: string }).evalMarker = "still here";
  });
  await first.browser.close();
  check("Chrome answers over CDP and keeps a page marker", true, `${first.waitedMs} ms`);

  // The live view: 403 without its token, then noVNC in a real browser.
  const { helperId } = await waitingHelper(db, userId, slot);
  // Served first: a live-view link points under where the HTTP layer serves the instance.
  const { origin, server } = await serveLiveView(sdk);
  const bare = await serveLiveView(sdk, { stripCsp: true });
  const { url } = await screenView(sdk, userId, { helperId });
  try {
    const token = url.split("/")[4]!;
    const refused = [
      await fetch(`${origin}${basePath}/screens/vnc.html`),
      await fetch(`${origin}${url.replace(token, "not-a-token")}`),
      await fetch(
        `${origin}${url.replace(token, `${token.slice(0, -2)}${token.at(-2) === "A" ? "B" : "A"}${token.slice(-1)}`)}`,
      ),
    ].map((response) => response.status);
    check(
      "the live-view link returns 403 without its token",
      refused.every((s) => s === 403),
      refused.join(", "),
    );
    const valid = await fetch(`${origin}${url}`);
    check(
      "the link with its token serves noVNC under a CSP sandbox",
      valid.status === 200 &&
        valid.headers.get("content-security-policy") === "sandbox allow-scripts",
      `HTTP ${valid.status}`,
    );
    await valid.arrayBuffer();
    const shot = (name: string) => (shotDirectory ? `${shotDirectory}/${name}.png` : undefined);
    await loadLiveView(
      `${origin}${url}`,
      `${bare.origin}${url}`,
      check,
      "before the pause",
      shot("live-view-before"),
    );

    // Pause the Computer with the Screen open, then wake it.
    await pause();
    const woke = Date.now();
    const second = await connectChrome(computer, slot, 90_000);
    check(
      "Chrome answers over CDP after the resume",
      second.browser !== null,
      second.browser ? `after ${second.waitedMs} ms` : second.error,
    );
    if (second.browser) {
      const survivor = second.browser
        .contexts()[0]
        ?.pages()
        .find((p) => p.url().startsWith("data:"));
      const marker = await survivor?.evaluate(
        () => (window as unknown as { evalMarker?: string }).evalMarker,
      );
      check(
        "Chrome kept its page across the pause",
        marker === "still here",
        `marker ${marker ?? "gone"}`,
      );
      await second.browser.close();
    }
    const dead = await deadProcesses(computer, slot);
    check(
      "Xvfb, x11vnc, websockify and Chromium survived the pause",
      dead.length === 0,
      dead.join("; "),
    );
    const display = await computer.run(`DISPLAY=:${slot} xdpyinfo | grep dimensions`, {
      timeoutMs: 15_000,
    });
    check(
      "the display answers after the resume",
      "stdout" in display && display.stdout.includes("1280x800"),
      "stdout" in display ? display.stdout.trim() : "timed out",
    );
    await loadLiveView(
      `${origin}${url}`,
      `${bare.origin}${url}`,
      check,
      "after the resume",
      shot("live-view-after"),
    );
    console.log(`      resume to Screen ready: ${Date.now() - woke} ms`);
  } finally {
    for (const { server: closing } of [{ server }, bare]) {
      closing.closeAllConnections();
      await new Promise((resolve) => closing.close(resolve));
    }
    await computer.closeScreen(slot).catch(() => {});
  }
}
