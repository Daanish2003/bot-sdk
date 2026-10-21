import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Probe for spec #713 / ticket #717: can the Host capture the user's browser events through the
// Screen's CDP connection? Approach 1: Playwright `context.addInitScript` + `context.exposeBinding`
// on the default context of a `connectOverCDP` browser. Approach 2: raw CDP per target.

/** The listener a capture ticket would inject into every document. */
const listener = `(() => {
  const send = (kind, target) => {
    const el = target instanceof Element ? target : null;
    window.__BINDING__({
      kind,
      url: location.href,
      top: window === window.top,
      label: el && (el.getAttribute("aria-label") || el.placeholder || el.textContent || "").trim().slice(0, 40),
      id: el && el.id,
      value: el && el.type === "password" ? "" : el && el.value,
    });
  };
  for (const kind of ["click", "input", "change", "keydown"]) {
    addEventListener(kind, (event) => send(kind, event.target), true);
  }
})()`;

type Seen = {
  kind: string;
  url: string;
  top: boolean;
  label: string | null;
  id: string | null;
  value: string | null;
};

let chrome: { url: string; close: () => Promise<void> };
let origin: Server;
let other: Server;
let originUrl: string;

const html = (body: string) => `<!doctype html><title>t</title>${body}`;

function serve(pages: (host: string) => Record<string, string>): Promise<Server> {
  const server = createServer((req, res) => {
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = pages(host)[req.url ?? "/"];
    res.writeHead(page ? 200 : 404, { "content-type": "text/html" });
    res.end(page ?? "");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function launchChrome() {
  const dir = await mkdtemp(join(tmpdir(), "probe-"));
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
    if (!port && tries > 100) throw new Error("DevTools port did not open");
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

beforeAll(async () => {
  other = await serve(() => ({ "/frame": html(`<button id="cross">Cross frame</button>`) }));
  const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  origin = await serve((host) => ({
    "/": html(`<button id="first">First</button><a id="next" href="/second">Next</a>
      <a id="tab" href="/second" target="_blank">Tab</a>
      <input id="pw" type="password" aria-label="Pass">
      <iframe src="${host}/same"></iframe><iframe src="${otherUrl}/frame"></iframe>`),
    "/second": html(`<button id="second">Second</button>`),
    "/same": html(`<button id="same">Same frame</button>`),
  }));
  originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  origin?.close();
  other?.close();
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 50));
  if (!check()) throw new Error(`timed out: ${what}`);
}

async function install(context: BrowserContext, name: string) {
  const seen: Seen[] = [];
  await context.exposeBinding(name, (_source, event: Seen) => void seen.push(event));
  await context.addInitScript(listener.replaceAll("__BINDING__", name));
  return seen;
}

const frameAt = (page: Page, suffix: string) =>
  page.frames().find((f) => f.url().endsWith(suffix))!;

describe("Playwright addInitScript + exposeBinding on the default context", () => {
  it("reports events from a page, after navigation, a new tab and iframes", async () => {
    const browser: Browser = await chromium.connectOverCDP(chrome.url);
    try {
      const context = browser.contexts()[0]!;
      const seen = await install(context, "__demo");

      const page = await context.newPage();
      await page.goto(`${originUrl}/`);
      await page.waitForLoadState("load");

      await page.locator("#first").click();
      await until(() => seen.some((e) => e.id === "first" && e.top), "click in the page");
      await frameAt(page, "/same").locator("#same").click();
      await until(() => seen.some((e) => e.id === "same" && !e.top), "same-origin iframe");
      await frameAt(page, "/frame").locator("#cross").click();
      await until(() => seen.some((e) => e.id === "cross" && !e.top), "cross-origin iframe");

      // A password input: the listener never sends the value.
      await page.locator("#pw").fill("hunter2");
      await until(() => seen.some((e) => e.kind === "input" && e.id === "pw"), "password input");
      expect(JSON.stringify(seen)).not.toContain("hunter2");

      // Navigation by link, then a click on the new document.
      await page.locator("#next").click();
      await page.waitForURL("**/second");
      await page.locator("#second").click();
      await until(() => seen.some((e) => e.id === "second"), "click after navigation");

      // A new tab opened by the page (target=_blank).
      await page.goto(`${originUrl}/`);
      seen.length = 0;
      const [tab] = await Promise.all([context.waitForEvent("page"), page.locator("#tab").click()]);
      await tab.waitForLoadState("load");
      await tab.locator("#second").click();
      await until(() => seen.some((e) => e.id === "second"), "click in a new tab");

      // A tab created outside Playwright by CDP, as a user's Ctrl+T would.
      seen.length = 0;
      const cdp = await browser.newBrowserCDPSession();
      const opened = context.waitForEvent("page");
      await cdp.send("Target.createTarget", { url: `${originUrl}/second` });
      const external = await opened;
      await external.waitForLoadState("load");
      await external.locator("#second").click();
      await until(() => seen.some((e) => e.id === "second"), "click in a CDP-created tab");
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("misses a page that was open before the init script, until its next document", async () => {
    const browser = await chromium.connectOverCDP(chrome.url);
    try {
      const context = browser.contexts()[0]!;
      const early = await context.newPage();
      await early.goto(`${originUrl}/second`);
      const seen = await install(context, "__demo2");
      await early.locator("#second").click();
      await new Promise((r) => setTimeout(r, 500));
      expect(seen).toEqual([]);
      await early.reload();
      await early.locator("#second").click();
      await until(() => seen.length > 0, "click after reload");
    } finally {
      await browser.close();
    }
  }, 60_000);
});
