import { expect, test, type Browser, type Page } from "@playwright/test";

import { baseURL, serverEnv } from "./env";
import { signInAsSeededUser } from "./helpers";
import {
  hostileMarker,
  hostileRepresentativeReply,
  replyMarker,
  representativeReply,
} from "./support/fake-ollama";
import { seedAutoTopic, startShopSite } from "./support/web-chat";

/*
 * The web chat widget (ticket #1340), on a shop's site that is a different origin from the app, so
 * the widget's calls are the cross-origin ones a real page makes.
 */

const unavailableNotice = "We can't answer right now. Please try again later.";
const endedNotice = "Your chat session has ended.";

/** An owner with a Representative whose web chat key allows `origin`; serving unless `serving` is false. */
async function ownerWithKey(page: Page, origin: string, { serving = true } = {}) {
  const owner = await signInAsSeededUser(page);
  await page.goto("/representatives");
  await page.getByLabel("Name").fill("Shop desk");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/representatives\/[\w-]+$/);
  await page.getByLabel("Job text").fill("Answer questions about opening hours.");
  await page.getByRole("button", { name: "Approve as a new Release" }).click();
  await expect(page.getByText("Live: Release 1")).toBeVisible();
  if (serving) {
    await page.getByRole("checkbox", { name: "Serving" }).click();
    await expect(page.getByRole("checkbox", { name: "Serving" })).toBeChecked();
  }
  await seedAutoTopic(owner.id);

  const section = page.locator("[data-representative-widget-key]");
  await section.getByRole("button", { name: "Create web chat key" }).click();
  const keyField = section.getByLabel("Public key");
  await expect(keyField).not.toHaveValue("");
  const key = await keyField.inputValue();
  await section.getByLabel("Allowed sites").fill(origin);
  await section.getByRole("button", { name: "Save allowed sites" }).click();
  await expect(page.getByText("Allowed sites saved").first()).toBeVisible();
  return { section, key };
}

/**
 * A visitor's browser. It sends none of the suite's extra headers: a custom header on a cross-origin
 * request makes a browser ask first, and a real visitor sends none.
 */
async function visitorPage(browser: Browser) {
  const context = await browser.newContext({ extraHTTPHeaders: {} });
  return context.newPage();
}

/** The shop's page with the widget in it, and the widget's parts. */
async function openShop(page: Page, origin: string, key: string) {
  const options = new URLSearchParams({ key, api: `${baseURL}/api/chat` });
  await page.goto(`${origin}/widget-example.html?${options}`);
  const chat = page.getByRole("region", { name: "Chat" });
  return {
    chat,
    field: chat.getByLabel("Your message"),
    send: chat.getByRole("button", { name: "Send", exact: true }),
    said: (text: string) => chat.locator(".message", { hasText: text }),
  };
}

test("a visitor chats with a Representative from a shop's page and keeps the thread on reload", async ({
  page: owner,
  browser,
}) => {
  const shop = await startShopSite();
  try {
    const { key } = await ownerWithKey(owner, shop.origin);
    const page = await visitorPage(browser);
    const preflights: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "OPTIONS") preflights.push(request.url());
    });

    const widget = await openShop(page, shop.origin, key);
    await expect(widget.field).toBeEnabled();
    await widget.field.fill(`Are you open today? ${replyMarker}`);
    await widget.send.click();
    await expect(widget.said("Are you open today?")).toBeVisible();
    await expect(widget.said(representativeReply)).toBeVisible({ timeout: 30_000 });
    await expect(widget.field).toHaveValue("");

    // The thread is still there after a reload, with no second session started.
    await page.reload();
    await expect(widget.said("Are you open today?")).toBeVisible();
    await expect(widget.said(representativeReply)).toBeVisible();
    await expect(widget.chat.locator(".message")).toHaveCount(2);

    // Neither the send nor the read needed a preflight.
    expect(preflights).toEqual([]);
  } finally {
    shop.server.close();
  }
});

test("a visitor asks for a code by email in the chat window, and a wrong one unlocks nothing (#1350)", async ({
  page: owner,
  browser,
}) => {
  const shop = await startShopSite();
  try {
    const { key } = await ownerWithKey(owner, shop.origin);
    const page = await visitorPage(browser);
    const preflights: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "OPTIONS") preflights.push(request.url());
    });
    const widget = await openShop(page, shop.origin, key);
    await expect(widget.field).toBeEnabled();
    await widget.field.fill("I'd like my order history");
    await widget.send.click();
    await expect(widget.said("I'd like my order history")).toBeVisible();

    await widget.chat.getByRole("button", { name: "Verify by email" }).click();
    await widget.chat.getByLabel("Your email address").fill("nobody@example.com");
    const asked = page.waitForResponse((response) => response.url().endsWith("/widget/code"));
    await widget.chat.getByRole("button", { name: "Send code" }).click();
    expect((await asked).status()).toBe(202);
    // The same words whether or not the address is on record.
    await expect(widget.chat.getByRole("status")).toHaveText(
      "If that address is on record, we've emailed a code to it. Enter it below.",
    );

    await widget.chat.getByLabel("Code from the email").fill("123456");
    await widget.chat.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(widget.chat.getByRole("status")).toHaveText(
      "That code is wrong or has expired. Ask for a new one if you need to.",
    );
    // Neither the address nor the code went into the chat.
    await expect(widget.chat.locator(".message", { hasText: "nobody@example.com" })).toHaveCount(0);
    await expect(widget.chat.locator(".message", { hasText: "123456" })).toHaveCount(0);
    expect(preflights).toEqual([]);
  } finally {
    shop.server.close();
  }
});

test("a returning visitor whose stored session has ended starts a new one, with nothing said", async ({
  page: owner,
  browser,
}) => {
  const shop = await startShopSite();
  try {
    const { key } = await ownerWithKey(owner, shop.origin);
    const page = await visitorPage(browser);
    const widget = await openShop(page, shop.origin, key);
    await expect(widget.field).toBeEnabled();
    await widget.field.fill("From my last visit");
    await widget.send.click();
    await expect(widget.said("From my last visit")).toBeVisible();

    // The stored token no longer opens anything, as when its session ran out between visits.
    const storeName = `botsdk-widget:${key}`;
    await page.evaluate(
      (name) => localStorage.setItem(name, "a-session-that-has-ended"),
      storeName,
    );
    await page.reload();

    await expect(widget.field).toBeEnabled();
    await expect(widget.chat.locator(".status")).toBeEmpty();
    await expect(widget.chat.getByRole("button", { name: "Start a new chat" })).toBeHidden();
    await expect(widget.chat.locator(".message")).toHaveCount(0);
    expect(await page.evaluate((name) => localStorage.getItem(name), storeName)).not.toBe(
      "a-session-that-has-ended",
    );
    await widget.field.fill(`Back again ${replyMarker}`);
    await widget.send.click();
    await expect(widget.said("Back again")).toBeVisible();
    await expect(widget.said(representativeReply)).toBeVisible({ timeout: 30_000 });
  } finally {
    shop.server.close();
  }
});

test("a visitor whose key is disabled is told their session has ended", async ({
  page,
  browser,
}) => {
  const shop = await startShopSite();
  try {
    const { key, section } = await ownerWithKey(page, shop.origin);
    const visitor = await visitorPage(browser);
    const widget = await openShop(visitor, shop.origin, key);
    await expect(widget.field).toBeEnabled();

    await section.getByRole("button", { name: "Disable key" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Disable key" }).click();
    await expect(section.getByText("Its chats have ended")).toBeVisible();

    // The open stream notices the end by itself, within its 25 s check.
    await expect(widget.chat.getByRole("status")).toHaveText(endedNotice, { timeout: 45_000 });
    await expect(widget.field).toBeDisabled();

    // A reload finds the stored session gone, and the key refusing a new one.
    await visitor.reload();
    await expect(widget.chat.getByRole("status")).toHaveText("Chat isn't available on this page.");
    await expect(widget.field).toBeDisabled();
  } finally {
    shop.server.close();
  }
});

test("a visitor is shown the notice when the Representative is switched off", async ({
  page,
  browser,
}) => {
  const shop = await startShopSite();
  try {
    const { key } = await ownerWithKey(page, shop.origin, { serving: false });
    const widget = await openShop(await visitorPage(browser), shop.origin, key);
    await expect(widget.field).toBeEnabled();
    await widget.field.fill("Hello?");
    await widget.send.click();
    await expect(widget.said("Hello?")).toBeVisible();
    await expect(widget.said(unavailableNotice)).toBeVisible({ timeout: 30_000 });
  } finally {
    shop.server.close();
  }
});

test("a visitor's and a Model's text show as text and run no script in the shop's page", async ({
  page: owner,
  browser,
}) => {
  const shop = await startShopSite();
  try {
    const { key } = await ownerWithKey(owner, shop.origin);
    const page = await visitorPage(browser);
    const widget = await openShop(page, shop.origin, key);
    await expect(widget.field).toBeEnabled();
    const visitorText = `<img src=x onerror="window.pwnedByVisitor = 1"><script>window.pwnedByVisitor = 2</script> ${replyMarker} ${hostileMarker}`;
    await widget.field.fill(visitorText);
    await widget.send.click();

    // Both arrive as the characters they are.
    await expect(widget.said(visitorText)).toBeVisible();
    await expect(widget.said(hostileRepresentativeReply)).toBeVisible({ timeout: 30_000 });
    // Nothing was made from them: no element in the widget but its own, and nothing ran.
    await expect(widget.chat.locator("img, script")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() => [
        (window as { pwnedByVisitor?: number }).pwnedByVisitor,
        (window as { pwnedByModel?: number }).pwnedByModel,
      ]),
    ).toEqual([undefined, undefined]);
  } finally {
    shop.server.close();
  }
});

test("the widget's script and the example page hold no secret", async ({ request }) => {
  const secrets = Object.entries(serverEnv)
    .filter(([name, value]) => /SECRET|KEY|PASSWORD|TOKEN/.test(name) && value.length >= 8)
    .map(([, value]) => value);
  expect(secrets.length).toBeGreaterThan(0);
  for (const path of ["/widget.js", "/widget-example.html"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    const source = await response.text();
    for (const secret of secrets) expect(source).not.toContain(secret);
  }
});
