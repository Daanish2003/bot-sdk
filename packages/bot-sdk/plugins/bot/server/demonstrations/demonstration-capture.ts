import { setTimeout as sleep } from "node:timers/promises";

import { and, asc, eq, max, sql } from "drizzle-orm";
import { type Browser, chromium, type Page } from "playwright-core";
import { z } from "zod";

import {
  botDemonstration,
  botDemonstrationEvent,
  deleteBlobsBestEffort,
} from "../../../../core/server/storage";
import type { BotSdkContext, Transaction } from "../../../../core/server/plugin";
import { rpcError } from "../../../../core/server/rpc-error";
import { defineCoreJob } from "../../../runner/server/internal";
import { type DemonstrationStep, isLiveDemonstration } from "../../shared/demonstration";
import { computerOf } from "../agent-loop";
import { demonstrationCaptureJobName, move, rewriteCard, startCapture } from "./demonstration";
import { lockConversation } from "../triggers";
import { hintChanged } from "../conversation";
import { helperJobBudget } from "../helpers";

/*
 * Capture (spec #713, ticket #719): while a Demonstration records, a listener in every page and frame
 * of its Screen's Chrome reports the user's steps over the Screen's CDP connection, as probe #717
 * settled (`exposeBinding` + `addInitScript` on the default context of `connectOverCDP`). The server
 * stores each with a screenshot of its page. A password field's value never leaves the page, and
 * no screenshot is taken for it, or while a password a toggle unmasked shows on its page. While
 * paused, steps are dropped here, before any screenshot.
 */

/** What stands for a password field's value. */
export const maskedValue = "••••••••";

/** The most steps a Demonstration stores; the one that reaches it ends the Demonstration as Done. */
export const demonstrationEventLimit = 200;

/** How often the capture checks that its Demonstration is still live. */
const checkMs = 500;

/** How long one round of the capture holds its connection before the next round takes over. */
const captureRoundMs = 3 * 60_000;

/** How long after a Chrome it couldn't reach, or a dropped connection, the next round starts. */
const reconnectMs = 5_000;

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
 *
 * A step stays queued in its page until the server has taken it, so one taken between two rounds'
 * connections, or while a round closes, isn't lost: the next round runs this again in every open
 * document, which sends the queue again. A document opened between rounds has no listener until
 * then; its page load is still reported, as the next round finds it loaded. Each step carries a
 * random id, so one sent again after the server took it (its answer lost) is stored once.
 */
const listenerSource = (name: string) => String.raw`(() => {
  const binding = ${JSON.stringify(name)};
  const flag = binding + "_listening";
  if (window[flag]) return window[flag + "_resend"]();
  if (!/^https?:$/.test(location.protocol)) return;
  Object.defineProperty(window, flag, { value: true });
  const mask = ${JSON.stringify(maskedValue)};
  const clip = (text, length) => (text || "").replace(/\s+/g, " ").trim().slice(0, length);
  // The steps the server hasn't taken yet, oldest first; past the step cap, the oldest goes.
  const queue = [];
  const deliver = (item) => {
    try {
      Promise.resolve(window[binding](item.step)).then(() => {
        const at = queue.indexOf(item);
        if (at >= 0) queue.splice(at, 1);
      }, () => {});
    } catch {}
  };
  Object.defineProperty(window, flag + "_resend", { value: () => queue.slice().forEach(deliver) });
  // A version 4 uuid; crypto.randomUUID needs a secure context, and a page may be plain http.
  const newId = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  };
  const send = (step) => {
    // Before the page's own handlers run, so a field a "show password" click unmasks is known.
    trackPasswords();
    const item = { step: { id: newId(), url: location.href, ...step } };
    queue.push(item);
    if (queue.length > ${demonstrationEventLimit}) queue.shift();
    deliver(item);
  };
  const target = (event) => {
    const element = event.composedPath ? event.composedPath()[0] : event.target;
    return element instanceof Element ? element : null;
  };
  // A field that was a password once stays masked, so a "show password" toggle can't unmask it.
  const passwords = new Set();
  const isPassword = (element) => {
    if (element instanceof HTMLInputElement && element.type === "password") passwords.add(element);
    return passwords.has(element);
  };
  const trackPasswords = () => {
    for (const element of document.querySelectorAll("input[type=password]")) passwords.add(element);
  };
  // Whether the page shows a password a toggle unmasked; the server takes no screenshot then.
  Object.defineProperty(window, flag + "_revealed", {
    value: () => {
      trackPasswords();
      for (const element of passwords) {
        if (element.isConnected && element.type !== "password" && element.value !== "") return true;
      }
      return false;
    },
  });
  addEventListener("focusin", (event) => {
    const element = target(event);
    if (element) isPassword(element);
  }, true);
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
    const clicked = element.closest(clickable) || element;
    // The browser clicks a label's control next, and that click is the step.
    if (clicked instanceof HTMLLabelElement && clicked.control && clicked.control !== element) return;
    flush();
    send(stepOf("click", clicked, null));
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
  id: z.uuid(),
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

/** The steps a Demonstration has stored, its pause marks left out, and its next sequence. */
const tally = async (tx: Transaction, demonstrationId: string) => {
  const [row] = await tx
    .select({
      steps: sql<number>`count(*) filter (where ${botDemonstrationEvent.kind} <> 'pause')`.mapWith(
        Number,
      ),
      last: max(botDemonstrationEvent.sequence),
    })
    .from(botDemonstrationEvent)
    .where(eq(botDemonstrationEvent.demonstrationId, demonstrationId));
  return { steps: row?.steps ?? 0, sequence: (row?.last ?? 0) + 1 };
};

/**
 * Whether Demonstration `demonstrationId` records, read when a step comes in: a step waits behind
 * the ones before it, so by the time it is stored a Resume may have followed the Pause it came in.
 */
const recordingNow = async (deps: BotSdkContext, demonstrationId: string) => {
  const [row] = await deps.db
    .select({ state: botDemonstration.state })
    .from(botDemonstration)
    .where(eq(botDemonstration.id, demonstrationId));
  return row?.state === "recording";
};

/**
 * Stores one step of Demonstration `demonstration.id`, while it records: its row, with the
 * screenshot `screenshot` takes (none for a masked step, or while a password shows), and its
 * card's step count. A step that came while it was paused or had ended (`received`, read when it
 * came) is dropped before any screenshot; one that a Pause overtakes while its screenshot is taken
 * is dropped, and its bytes deleted. One already stored, sent again, is skipped. The screenshot is
 * put in the blob store before the row is written, outside the locks, so a row is never read
 * before the bytes its key names; a put that fails stores the step without one. The step that
 * reaches `demonstrationEventLimit` ends it as Done.
 */
async function storeStep(
  deps: BotSdkContext,
  demonstration: Captured,
  step: ReportedStep,
  received: Promise<boolean>,
  screenshot: () => Promise<Uint8Array | null>,
) {
  if (!(await received)) return;
  // A step its page sent again, after this or an earlier round took it.
  const id = step.id;
  const [taken] = await deps.db
    .select({ id: botDemonstrationEvent.id })
    .from(botDemonstrationEvent)
    .where(eq(botDemonstrationEvent.id, id));
  if (taken) return;
  const png = step.masked ? null : await screenshot().catch(() => null);
  const screenshotKey = png ? demonstrationEventBlobKey(demonstration.id, id) : null;
  const put =
    png && screenshotKey
      ? await deps.blobStore.put(screenshotKey, png, { contentType: "image/png" }).then(
          () => true,
          (caught: unknown) => {
            deps.logger.error("Storing a Demonstration step's screenshot failed", caught);
            return false;
          },
        )
      : false;
  const stored = await deps.db.transaction(async (tx) => {
    // In the order a Pause takes them, so a step never lands after the Pause that dropped it.
    await lockConversation(tx, demonstration.conversationId);
    const [row] = await tx
      .select({ state: botDemonstration.state, startedAt: botDemonstration.startedAt })
      .from(botDemonstration)
      .where(eq(botDemonstration.id, demonstration.id))
      .for("update");
    if (row?.state !== "recording") return undefined;
    const { steps: before, sequence } = await tally(tx, demonstration.id);
    const steps = before + 1;
    if (steps > demonstrationEventLimit) return undefined;
    await tx.insert(botDemonstrationEvent).values({
      id,
      demonstrationId: demonstration.id,
      sequence,
      offsetMs: Math.max(0, deps.clock().getTime() - row.startedAt.getTime()),
      kind: step.kind,
      url: step.url,
      label: step.label,
      selector: step.selector,
      value: step.masked && step.value !== null ? maskedValue : step.value,
      screenshotKey: put ? screenshotKey : null,
    });
    await rewriteCard(tx, demonstration.conversationId, demonstration.id, deps.clock(), (card) => ({
      ...card,
      steps,
    }));
    return steps;
  });
  if (stored === undefined) {
    // Dropped: a Pause or the cap overtook it, so its bytes go too.
    if (put && screenshotKey) await deleteBlobsBestEffort(deps, [screenshotKey]);
    return;
  }
  await hintChanged(deps, demonstration.conversationId);
  if (stored >= demonstrationEventLimit) await move(deps, demonstration.id, "done");
}

/**
 * Whether a frame of `page` shows a password that a "show password" toggle unmasked, as the
 * listener of binding `name` there tells. A frame that can't be asked (it is navigating) counts as
 * not showing one.
 */
async function passwordShown(page: Page, name: string): Promise<boolean> {
  const check = `window[${JSON.stringify(`${name}_listening_revealed`)}]?.() === true`;
  const shown = await Promise.all(
    page.frames().map((frame) => frame.evaluate(check).catch(() => false)),
  );
  return shown.includes(true);
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
  pending: { chain: Promise<void>; closing: boolean },
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
      // Refused, so the page keeps it for the next round.
      if (pending.closing) throw new Error("The capture's round is closing");
      const received = recordingNow(deps, demonstration.id).catch((caught: unknown) => {
        deps.logger.error("Reading a Demonstration's state failed", caught);
        return false;
      });
      pending.chain = pending.chain
        .then(() =>
          storeStep(deps, demonstration, step.data, received, async () =>
            (await passwordShown(page, name))
              ? null
              : page.screenshot({ type: "png", timeout: screenshotTimeoutMs }),
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
 * The capture of one Demonstration (#719), queued once its Screen opened, in the Helpers' budget
 * since it runs for as long as the user shows: in rounds of up to `captureRoundMs`, each one job holding
 * a CDP connection to the Screen's Chrome while the Demonstration is live, so no attempt nears the
 * runner's attempt cap and a deploy's drain waits for one round at most. A round that ends with the
 * Demonstration still live queues the next; one whose Chrome it can't reach, or whose connection
 * dropped, queues it `reconnectMs` later. A round stores the steps already reported before it ends;
 * the pages keep the ones it refuses while it closes, and send them to the next.
 */
export const demonstrationCaptureJob = defineCoreJob({
  name: demonstrationCaptureJobName,
  ...helperJobBudget,
  payload: z.object({ demonstrationId: z.uuid(), round: z.number().int().min(1).default(1) }),
  run: async ({ demonstrationId, round }, { deps, signal }) => {
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
    const pending = { chain: Promise.resolve(), closing: false };
    let browser: Browser;
    try {
      browser = await connect(deps, demonstration, pending);
    } catch (caught) {
      deps.logger.error(`Capturing Demonstration ${demonstrationId} couldn't connect`, caught);
      await startCapture(deps, demonstrationId, round + 1, reconnectMs);
      return;
    }
    const ends = Date.now() + captureRoundMs;
    try {
      while (browser.isConnected() && Date.now() < ends && (await live())) {
        await sleep(checkMs, undefined, { signal });
      }
    } finally {
      // Steps that come while the round stores the last ones are stored too; only once the chain
      // is done are new ones refused, for the page to send to the next round.
      for (let chain: Promise<void> | undefined; chain !== pending.chain;) {
        chain = pending.chain;
        await chain;
      }
      pending.closing = true;
      await browser.close().catch(() => {});
    }
    if (await live()) {
      await startCapture(deps, demonstrationId, round + 1, Date.now() < ends ? reconnectMs : 0);
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
