import { toolDefinition } from "@tanstack/ai";
import { type Browser, chromium, type Locator, type Page } from "playwright-core";
import { z } from "zod";

import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { type ComputerHandle, ComputerOperationError } from "../../computer/server/plugin";
import { spillPath } from "./computer-tools";
import type { LoopKit } from "./loop";

/** What an action on a ref returns when the ref isn't on the page the connection last read. */
export const staleRefError =
  "That ref is from an old snapshot; call browser_snapshot and try again.";

/** What an action returns when the browser's connection dropped while it ran. */
export const interruptedActionError =
  "The browser restarted during this action, so it may or may not have happened. Call " +
  "browser_snapshot to see the page.";

/** What stands for the snapshot when an action happened but the page couldn't be read after it. */
export const unreadPageNote = (error: string) =>
  `The action happened, but the page couldn't be read after it (${error}). Don't repeat the ` +
  "action; call browser_snapshot to see the page.";

/** A snapshot longer than this goes to a file, and the result keeps its start. */
export const snapshotLimit = 20_000;

/** How long one browser action may wait for its element or page. */
const actionTimeoutMs = 15_000;

/** How long a navigation may take. */
const navigationTimeoutMs = 30_000;

/** An action named a ref that no element of the page has. */
class StaleRefError extends Error {}

/**
 * The Chrome of a Computer-use Helper's Screen, driven over CDP from the server (#569): one
 * connection per job attempt, held in memory, since refs die with it. It connects on first use,
 * opening the Screen when it isn't open, and reconnects when the connection drops (a lost
 * sandbox), reopening the Screen then.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private current: Page | undefined;
  readonly slot: number;
  private readonly profileKey: string;

  // Not parameter properties: the hand-run evals load this file in Node's strip-only mode.
  constructor(slot: number, profileKey: string) {
    this.slot = slot;
    this.profileKey = profileKey;
  }

  /** Connects to the Screen's Chrome, opening the Screen first when it isn't open. */
  async open(computer: ComputerHandle): Promise<void> {
    if (this.browser?.isConnected()) return;
    this.drop();
    try {
      this.browser = await this.connect(computer);
    } catch {
      // Not open, or its Chrome is gone (a rebuilt or restarted sandbox): open it afresh.
      await computer.openScreen(this.slot, this.profileKey);
      try {
        this.browser = await this.connect(computer);
      } catch (caught) {
        throw new ComputerOperationError(caught);
      }
    }
  }

  /** Ends this attempt's connection. The Screen and its Chrome keep running. */
  async close(): Promise<void> {
    const browser = this.browser;
    this.drop();
    await browser?.close().catch(() => {});
  }

  /**
   * Runs `action` on the current tab, if any, then reads it afresh. A ref that isn't on the page
   * is the stale-ref error. A connection that dropped before the action is reopened first; one
   * that drops during it is reopened too, but the action isn't run again, since it may have
   * happened. An action that happened stays done when the page can't be read after it (a
   * navigation destroyed it): the snapshot is then `unreadPageNote`, so it isn't repeated.
   */
  async act(
    computer: ComputerHandle,
    action?: (page: Page) => Promise<string>,
  ): Promise<{ result?: string; snapshot: string } | { error: string }> {
    await this.open(computer);
    let result: string | undefined;
    try {
      if (action) result = await action(await this.page());
      const snapshot = await snapshotOf(await this.page());
      return result === undefined ? { snapshot } : { result, snapshot };
    } catch (caught) {
      if (caught instanceof StaleRefError) return { error: staleRefError };
      // The next call reconnects first, as every call does.
      if (result !== undefined) return { result, snapshot: unreadPageNote(firstLine(caught)) };
      if (this.browser?.isConnected()) return { error: firstLine(caught) };
      await this.open(computer);
      return { error: interruptedActionError };
    }
  }

  /** The current tab, or the first, or a new one when there is none. */
  async page(): Promise<Page> {
    const context = this.browser!.contexts()[0] ?? (await this.browser!.newContext());
    if (!this.current || this.current.isClosed() || !context.pages().includes(this.current)) {
      this.current = context.pages()[0] ?? (await context.newPage());
    }
    this.current.setDefaultTimeout(actionTimeoutMs);
    this.current.setDefaultNavigationTimeout(navigationTimeoutMs);
    return this.current;
  }

  /** The tabs, in order, and the current one's index. */
  async tabs(): Promise<{ pages: Page[]; current: number }> {
    const current = await this.page();
    const pages = current.context().pages();
    return { pages, current: pages.indexOf(current) };
  }

  /** Makes `page` the current tab. */
  select(page: Page): void {
    this.current = page;
  }

  private async connect(computer: ComputerHandle): Promise<Browser> {
    const { cdp } = await computer.screenUrls(this.slot);
    return chromium.connectOverCDP(cdp.url, { headers: cdp.headers, timeout: navigationTimeoutMs });
  }

  private drop() {
    this.browser = undefined;
    this.current = undefined;
  }
}

/** The page's URL and title, then its ARIA snapshot in `ai` mode, whose refs the actions take. */
async function snapshotOf(page: Page): Promise<string> {
  const aria = await page.ariaSnapshot({ mode: "ai" });
  return `- Page URL: ${page.url()}\n- Page Title: ${await page.title()}\n${aria}`;
}

/** The element of `ref` on the page the connection last read, or the stale-ref error. */
async function byRef(page: Page, ref: string): Promise<Locator> {
  const locator = page.locator(`aria-ref=${ref}`);
  // An unknown ref would wait out the timeout: a count answers at once.
  if ((await locator.count().catch(() => 0)) === 0) throw new StaleRefError();
  return locator;
}

/** An error's first line, which is Playwright's summary. */
function firstLine(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  return message.split("\n")[0]!.trim();
}

/**
 * A snapshot capped at `snapshotLimit` characters: a longer one is written to `path` with `save`,
 * and the result keeps its start and that path.
 */
export async function capSnapshot(
  snapshot: string,
  path: string,
  save: (path: string, content: string) => Promise<void>,
): Promise<{ snapshot: string; snapshotPath?: string }> {
  if (snapshot.length <= snapshotLimit) return { snapshot };
  // The page was read already, so a failed save must not fail the call.
  const saved = await save(path, snapshot).then(
    () => true,
    () => false,
  );
  const head = `${snapshot.slice(0, snapshotLimit)}\n[... ${snapshot.length - snapshotLimit} more characters ...]`;
  return saved ? { snapshot: head, snapshotPath: path } : { snapshot: head };
}

const refField = z.string().meta({ description: "An element's ref from the latest snapshot." });

const snapshotNote =
  "It returns a one-line result and a fresh snapshot of the page, whose refs the other browser " +
  "tools take.";

const navigateDefinition = toolDefinition({
  name: "browser_navigate",
  description: `Open a URL in the current tab of your Screen's browser, or go back. ${snapshotNote}`,
  inputSchema: z.object({
    url: z.string().min(1).meta({ description: 'The URL to open, or "back".' }),
  }),
});

const snapshotDefinition = toolDefinition({
  name: "browser_snapshot",
  description:
    "Read the current tab as an ARIA snapshot: its URL, title and elements, each with a ref the " +
    `other browser tools take. A snapshot over ${snapshotLimit} characters is written to a file; ` +
    "you get its start and the file's path.",
  inputSchema: z.object({}),
});

const clickDefinition = toolDefinition({
  name: "browser_click",
  description: `Click the element with this ref. ${snapshotNote}`,
  inputSchema: z.object({ ref: refField }),
});

const typeDefinition = toolDefinition({
  name: "browser_type",
  description: `Replace the text in the field with this ref. ${snapshotNote}`,
  inputSchema: z.object({
    ref: refField,
    text: z.string(),
    submit: z.boolean().optional().meta({ description: "Press Enter after typing." }),
  }),
});

const selectDefinition = toolDefinition({
  name: "browser_select",
  description: `Choose options in the select with this ref, by value or label. ${snapshotNote}`,
  inputSchema: z.object({ ref: refField, values: z.array(z.string()).min(1) }),
});

const pressDefinition = toolDefinition({
  name: "browser_press",
  description: `Press a key in the current tab, such as Enter, Escape, ArrowDown or Control+A. ${snapshotNote}`,
  inputSchema: z.object({ key: z.string().min(1) }),
});

const tabsDefinition = toolDefinition({
  name: "browser_tabs",
  description:
    "List the browser's tabs, open a new one, make one current, or close one (the current one when " +
    `no index is given). ${snapshotNote}`,
  inputSchema: z.object({
    action: z.enum(["list", "new", "select", "close"]),
    index: z.number().int().min(0).optional().meta({ description: "The tab, from 0." }),
  }),
});

/**
 * The Browser tools of a Computer-use Helper (#569), on `session`'s Screen. Each is one Computer
 * call of the loop: a snapshot over `snapshotLimit` characters spills to a file in the Bot's
 * directory. The acting ones (click, type, select and press) get Auto-review first (spec #691);
 * the looking ones (navigate, snapshot and tabs) don't.
 */
export function browserTools(
  session: BrowserSession,
  botId: string,
  computerCall: LoopKit["computerCall"],
) {
  /**
   * A tool whose call runs `run` on the Screen and caps the snapshot its result holds, after
   * Auto-review when it is `reviewed`.
   */
  const tool =
    <Input>(
      name: string,
      run: (
        computer: ComputerHandle,
        input: Input,
      ) => Promise<{ result?: string; snapshot: string } | { error: string }>,
      reviewed = false,
    ) =>
    (input: Input, context?: { toolCallId?: string }) =>
      computerCall(
        name,
        context?.toolCallId,
        async (computer, _live, mask) => {
          const read = await run(computer, input);
          if ("error" in read) return read;
          // Masked before the cut, so a Secret's value is never half kept by it.
          const capped = await capSnapshot(
            mask(read.snapshot),
            spillPath(botId, context?.toolCallId ?? uuidv7()),
            computer.writeFile,
          );
          return read.result === undefined ? capped : { result: read.result, ...capped };
        },
        { capped: false, reviewed: reviewed ? (input as Record<string, unknown>) : undefined },
      );

  return [
    navigateDefinition.server(
      tool("browser_navigate", (computer, { url }: { url: string }) =>
        session.act(computer, async (page) => {
          if (url === "back") {
            await page.goBack({ waitUntil: "domcontentloaded" });
            return `Went back to ${page.url()}`;
          }
          await page.goto(url, { waitUntil: "domcontentloaded" });
          return `Opened ${page.url()}`;
        }),
      ),
    ),
    snapshotDefinition.server(tool("browser_snapshot", (computer) => session.act(computer))),
    clickDefinition.server(
      tool(
        "browser_click",
        (computer, { ref }: { ref: string }) =>
          session.act(computer, async (page) => {
            await (await byRef(page, ref)).click();
            return `Clicked ${ref}`;
          }),
        true,
      ),
    ),
    typeDefinition.server(
      tool(
        "browser_type",
        (computer, { ref, text, submit }: { ref: string; text: string; submit?: boolean }) =>
          session.act(computer, async (page) => {
            const field = await byRef(page, ref);
            await field.fill(text);
            if (!submit) return `Typed into ${ref}`;
            await field.press("Enter");
            return `Typed into ${ref} and pressed Enter`;
          }),
        true,
      ),
    ),
    selectDefinition.server(
      tool(
        "browser_select",
        (computer, { ref, values }: { ref: string; values: string[] }) =>
          session.act(computer, async (page) => {
            const chosen = await (await byRef(page, ref)).selectOption(values);
            return `Selected ${chosen.join(", ")} in ${ref}`;
          }),
        true,
      ),
    ),
    pressDefinition.server(
      tool(
        "browser_press",
        (computer, { key }: { key: string }) =>
          session.act(computer, async (page) => {
            await page.keyboard.press(key);
            return `Pressed ${key}`;
          }),
        true,
      ),
    ),
    tabsDefinition.server(
      tool(
        "browser_tabs",
        (
          computer,
          { action, index }: { action: "list" | "new" | "select" | "close"; index?: number },
        ) =>
          session.act(computer, async (page) => {
            if (action === "new") {
              session.select(await page.context().newPage());
              return "Opened a new tab";
            }
            const { pages, current } = await session.tabs();
            const at = index ?? current;
            const target = pages[at];
            if (action !== "list" && !target) {
              throw new Error(`There is no tab ${at}; there are ${pages.length}.`);
            }
            if (action === "select") session.select(target!);
            if (action === "close") await target!.close();
            if (action !== "list")
              return `${action === "select" ? "Selected" : "Closed"} tab ${at}`;
            const titles = await Promise.all(pages.map((tab) => tab.title()));
            return pages
              .map(
                (tab, i) => `${i}: ${titles[i]} (${tab.url()})${i === current ? " [current]" : ""}`,
              )
              .join("; ");
          }),
      ),
    ),
  ];
}
