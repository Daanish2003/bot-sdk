import { setTimeout as sleep } from "node:timers/promises";

import { and, asc, count, eq, ne } from "drizzle-orm";
import { type Browser, chromium, type Page } from "playwright-core";
import { z } from "zod";

import { botDemonstration, botDemonstrationEvent } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { Database } from "../../../core/server/db/index";
import type { BotSdkContext, Transaction } from "../../../core/server/plugin";
import { rpcError } from "../../../core/server/rpc-error";
import { defineJob } from "../../runner/server/jobs/define";
import { type DemonstrationStep, isLiveDemonstration } from "../shared/demonstration";
import { computerOf } from "./computer-tools";
import { demonstrationCaptureJobName, move, nextSequence, rewriteCard } from "./demonstration";
import { lockConversation } from "./router";
import { hintChanged } from "./turn";

/*
 * Capture (spec #713, ticket #719): while a Demonstration records, a listener in every page and frame
 * of its Screen's Chrome reports the user's steps over the Screen's CDP connection, as probe #717
 * settled (`exposeBinding` + `addInitScript` on the default context of `connectOverCDP`). The server
 * stores each with a screenshot of its page. A password field's value never leaves the page, and
 * no screenshot is taken for it. While paused, steps are dropped here, before any screenshot.
 */

/** What stands for a password field's value. */
export const maskedValue = "••••••••";

/** The most steps a Demonstration stores; the one that reaches it ends the Demonstration as Done. */
export const demonstrationEventLimit = 200;

/** How often the capture checks that its Demonstration is still live. */
const checkMs = 500;

/** How long a step's screenshot may take before the step is stored without one. */
const screenshotTimeoutMs = 5_000;

/** The blob key of a Demonstration step's screenshot. */
export const demonstrationEventBlobKey = (demonstrationId: string, eventId: string) =>
  `demonstration/${demonstrationId}/${eventId}`;

/**
 * The listener, run in every document of the Screen's Chrome, which reports each step to the
 * binding `name`. Clicks, settled typing (`input`, sent once the field rests, loses focus or the
 * user does something else), changes of selects, checkboxes and the like (`change`), Enter, Tab,
 * Escape and shortcuts (`key`), and the top frame's page loads (`navigation`). Each carries the
 * frame's URL, the element's label and a CSS selector. In capture phase, so a page's own handlers
 * can't hide a step. A string, not a function, so no bundler's helpers end up in the page.
 */
const listenerSource = (name: string) => String.raw`(() => {
  const binding = ${JSON.stringify(name)};
  const flag = binding + "_listening";
  if (window[flag] || !/^https?:$/.test(location.protocol)) return;
  Object.defineProperty(window, flag, { value: true });
  const mask = ${JSON.stringify(maskedValue)};
  const clip = (text, length) => (text || "").replace(/\s+/g, " ").trim().slice(0, length);
  const send = (step) => {
    try {
      Promise.resolve(window[binding]({ url: location.href, ...step })).catch(() => {});
    } catch {}
  };
  const target = (event) => {
    const element = event.composedPath ? event.composedPath()[0] : event.target;
    return element instanceof Element ? element : null;
  };
  const isPassword = (element) =>
    element instanceof HTMLInputElement && element.type === "password";
  const isTyped = (element) =>
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable ||
    (element instanceof HTMLInputElement &&
      !["checkbox", "radio", "file", "range", "color", "submit", "button", "reset", "image"].includes(
        element.type,
      ));
  const labelOf = (element) =>
    clip(element.getAttribute("aria-label"), 100) ||
    clip(element.labels && element.labels[0] && element.labels[0].textContent, 100) ||
    clip(element.getAttribute("placeholder"), 100) ||
    clip(element.innerText || element.textContent, 100) ||
    clip(element.getAttribute("title") || element.getAttribute("name") || element.getAttribute("alt"), 100) ||
    null;
  const selectorOf = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return "#" + CSS.escape(element.id);
    for (const attribute of ["data-testid", "name", "aria-label"]) {
      const value = element.getAttribute(attribute);
      if (value) return tag + "[" + attribute + '="' + CSS.escape(value) + '"]';
    }
    const path = [];
    for (let node = element; node && node.nodeType === 1 && path.length < 5; node = node.parentElement) {
      if (node !== element && node.id) {
        path.unshift("#" + CSS.escape(node.id));
        break;
      }
      const same = node.parentElement
        ? [...node.parentElement.children].filter((child) => child.tagName === node.tagName)
        : [];
      const kind = node.tagName.toLowerCase();
      path.unshift(same.length > 1 ? kind + ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : kind);
    }
    return path.join(" > ");
  };
  const valueOf = (element) =>
    element.isContentEditable ? clip(element.innerText, 500) : String(element.value ?? "").slice(0, 500);
  const stepOf = (kind, element, value) => {
    const masked = isPassword(element);
    return {
      kind,
      label: labelOf(element),
      selector: selectorOf(element),
      value: value === null ? null : masked ? mask : value,
      masked,
    };
  };
  // Typing is sent once per field, when it rests or the user moves on; what was sent is kept here
  // (never sent for a password) so the field's change after it isn't sent again.
  let typing = null;
  let timer = 0;
  const sentValues = new WeakMap();
  const flush = () => {
    clearTimeout(timer);
    const element = typing;
    typing = null;
    if (!element) return;
    const value = valueOf(element);
    if (sentValues.get(element) === value) return;
    sentValues.set(element, value);
    send(stepOf("input", element, value));
  };
  const clickable =
    "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[onclick]";
  addEventListener("click", (event) => {
    const element = target(event);
    if (!element) return;
    flush();
    send(stepOf("click", element.closest(clickable) || element, null));
  }, true);
  addEventListener("input", (event) => {
    const element = target(event);
    if (!element || !isTyped(element)) return;
    if (typing !== element) flush();
    typing = element;
    clearTimeout(timer);
    timer = setTimeout(flush, 1000);
  }, true);
  addEventListener("change", (event) => {
    const element = target(event);
    if (!element) return;
    flush();
    if (isTyped(element)) {
      const value = valueOf(element);
      if (sentValues.get(element) === value) return;
      sentValues.set(element, value);
      send(stepOf("input", element, value));
      return;
    }
    const value =
      element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
        ? String(element.checked)
        : element instanceof HTMLSelectElement
          ? [...element.selectedOptions].map((option) => option.label).join(", ")
          : valueOf(element);
    send(stepOf("change", element, value));
  }, true);
  addEventListener("keydown", (event) => {
    const named = ["Enter", "Tab", "Escape"].includes(event.key);
    const shortcut = (event.ctrlKey || event.metaKey || event.altKey) && event.key.length === 1;
    if (!named && !shortcut) return;
    const element = target(event) || document.body;
    flush();
    const keys = [event.ctrlKey && "Control", event.metaKey && "Meta", event.altKey && "Alt", event.shiftKey && shortcut && "Shift", event.key];
    send(stepOf("key", element, keys.filter(Boolean).join("+")));
  }, true);
  addEventListener("blur", flush, true);
  addEventListener("pagehide", flush, true);
  if (window === window.top) {
    const loaded = () => send({ kind: "navigation", label: clip(document.title, 100) || null, selector: null, value: null, masked: false });
    if (document.readyState === "complete") loaded();
    else addEventListener("load", loaded, { once: true });
    addEventListener("hashchange", loaded, true);
    addEventListener("popstate", loaded, true);
  }
})()`;

/** A step as the listener reports it. It comes from a page, so each field is checked and cut. */
const reportedStepSchema = z.object({
  kind: z.enum(["click", "input", "change", "key", "navigation"]),
  url: z.string().transform((url) => url.slice(0, 2_000)),
  label: z
    .string()
    .nullable()
    .transform((label) => label?.slice(0, 200) ?? null),
  selector: z
    .string()
    .nullable()
    .transform((selector) => selector?.slice(0, 500) ?? null),
  value: z
    .string()
    .nullable()
    .transform((value) => value?.slice(0, 500) ?? null),
  masked: z.boolean(),
});

type ReportedStep = z.infer<typeof reportedStepSchema>;

/** A Demonstration as the capture reads it. */
type Captured = {
  id: string;
  userId: string;
  conversationId: string;
  screen: number;
};

/** The steps a Demonstration has stored, its pause marks left out. */
const capturedCount = async (db: Database | Transaction, demonstrationId: string) => {
  const [row] = await db
    .select({ steps: count() })
    .from(botDemonstrationEvent)
    .where(
      and(
        eq(botDemonstrationEvent.demonstrationId, demonstrationId),
        ne(botDemonstrationEvent.kind, "pause"),
      ),
    );
  return row?.steps ?? 0;
};

/**
 * Stores one step of Demonstration `demonstration.id`, while it records: its row, with the
 * screenshot `screenshot` takes (none for a masked step), and its card's step count. A step that
 * comes while it is paused or has ended is dropped before any screenshot. The step that reaches
 * `demonstrationEventLimit` ends it as Done.
 */
async function storeStep(
  deps: BotSdkContext,
  demonstration: Captured,
  step: ReportedStep,
  screenshot: () => Promise<Uint8Array>,
) {
  const recording = async () => {
    const [row] = await deps.db
      .select({ state: botDemonstration.state })
      .from(botDemonstration)
      .where(eq(botDemonstration.id, demonstration.id));
    return row?.state === "recording";
  };
  if (!(await recording())) return;
  const png = step.masked ? null : await screenshot().catch(() => null);
  const stored = await deps.db.transaction(async (tx) => {
    // In the order a Pause takes them, so a step never lands after the Pause that dropped it.
    await lockConversation(tx, demonstration.conversationId);
    const [row] = await tx
      .select({ state: botDemonstration.state, startedAt: botDemonstration.startedAt })
      .from(botDemonstration)
      .where(eq(botDemonstration.id, demonstration.id))
      .for("update");
    if (row?.state !== "recording") return undefined;
    const steps = (await capturedCount(tx, demonstration.id)) + 1;
    if (steps > demonstrationEventLimit) return undefined;
    const id = uuidv7();
    const screenshotKey = png ? demonstrationEventBlobKey(demonstration.id, id) : null;
    await tx.insert(botDemonstrationEvent).values({
      id,
      demonstrationId: demonstration.id,
      sequence: await nextSequence(tx, demonstration.id),
      offsetMs: Math.max(0, deps.clock().getTime() - row.startedAt.getTime()),
      kind: step.kind,
      url: step.url,
      label: step.label,
      selector: step.selector,
      value: step.masked && step.value !== null ? maskedValue : step.value,
      screenshotKey,
    });
    if (png && screenshotKey) {
      await deps.blobStore.put(screenshotKey, png, { contentType: "image/png" });
    }
    await rewriteCard(tx, demonstration.conversationId, demonstration.id, (card) => ({
      ...card,
      steps,
    }));
    return steps;
  });
  if (stored === undefined) return;
  await hintChanged(deps, demonstration.conversationId);
  if (stored >= demonstrationEventLimit) await move(deps, demonstration.id, "done");
}

/**
 * Connects to the Screen's Chrome and sets the listener up: on every document to come, and on the
 * ones already open (a page open before `addInitScript` isn't covered until its next document).
 * The binding's name is the Demonstration's, so a listener left from an earlier connection reports
 * to this one. Each step is stored in the order it came.
 */
async function connect(
  deps: BotSdkContext,
  demonstration: Captured,
  pending: { chain: Promise<void> },
): Promise<Browser> {
  const { cdp } = await computerOf(deps, demonstration.userId).screenUrls(demonstration.screen);
  const browser = await chromium.connectOverCDP(cdp.url, { headers: cdp.headers, timeout: 30_000 });
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("The Screen's Chrome has no browser context");
    const name = `__botDemonstration_${demonstration.id.replaceAll("-", "")}`;
    await context.exposeBinding(name, ({ page }: { page: Page }, reported: unknown) => {
      const step = reportedStepSchema.safeParse(reported);
      if (!step.success) return;
      pending.chain = pending.chain
        .then(() =>
          storeStep(deps, demonstration, step.data, () =>
            page.screenshot({ type: "png", timeout: screenshotTimeoutMs }),
          ),
        )
        .catch((caught) => deps.logger.error("Storing a Demonstration step failed", caught));
    });
    const source = listenerSource(name);
    await context.addInitScript(source);
    for (const page of context.pages()) {
      for (const frame of page.frames()) await frame.evaluate(source).catch(() => {});
    }
    return browser;
  } catch (caught) {
    await browser.close().catch(() => {});
    throw caught;
  }
}

/**
 * The capture of one Demonstration (#719), queued once its Screen opened: it holds a CDP connection
 * to the Screen's Chrome while the Demonstration is live, in the `helper` lane, since it runs for as
 * long as the user shows. A Chrome it can't reach, or a connection that drops, ends the job; the
 * Demonstration's time-cap check queues it again within a minute. It ends once the Demonstration
 * has, after storing the steps already reported.
 */
export const demonstrationCaptureJob = defineJob({
  name: demonstrationCaptureJobName,
  lane: "helper",
  payload: z.object({ demonstrationId: z.uuid() }),
  run: async ({ demonstrationId }, { deps, signal }) => {
    const live = async () => {
      const [row] = await deps.db
        .select({
          id: botDemonstration.id,
          userId: botDemonstration.userId,
          conversationId: botDemonstration.conversationId,
          screen: botDemonstration.screen,
          state: botDemonstration.state,
        })
        .from(botDemonstration)
        .where(eq(botDemonstration.id, demonstrationId));
      return row && isLiveDemonstration(row.state) ? row : undefined;
    };
    const demonstration = await live();
    if (!demonstration) return;
    const pending = { chain: Promise.resolve() };
    let browser: Browser;
    try {
      browser = await connect(deps, demonstration, pending);
    } catch (caught) {
      deps.logger.error(`Capturing Demonstration ${demonstrationId} couldn't connect`, caught);
      return;
    }
    try {
      while (browser.isConnected() && (await live())) await sleep(checkMs, undefined, { signal });
    } finally {
      await pending.chain;
      await browser.close().catch(() => {});
    }
  },
});

/**
 * The steps of the user's Demonstration `demonstrationId`, in order, with its pause marks: what
 * "What Planner sees" lists. Another user's is not found.
 */
export async function demonstrationSteps(
  deps: BotSdkContext,
  userId: string,
  demonstrationId: string,
): Promise<{ steps: DemonstrationStep[] }> {
  const [owned] = await deps.db
    .select({ id: botDemonstration.id })
    .from(botDemonstration)
    .where(and(eq(botDemonstration.id, demonstrationId), eq(botDemonstration.userId, userId)));
  if (!owned) throw rpcError("NOT_FOUND", "error.demonstrationNotFound", "Demonstration not found");
  const steps = await deps.db
    .select({
      sequence: botDemonstrationEvent.sequence,
      offsetMs: botDemonstrationEvent.offsetMs,
      kind: botDemonstrationEvent.kind,
      url: botDemonstrationEvent.url,
      label: botDemonstrationEvent.label,
      value: botDemonstrationEvent.value,
    })
    .from(botDemonstrationEvent)
    .where(eq(botDemonstrationEvent.demonstrationId, demonstrationId))
    .orderBy(asc(botDemonstrationEvent.sequence));
  return { steps };
}
