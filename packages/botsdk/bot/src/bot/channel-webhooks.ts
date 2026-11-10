import { z } from "zod";

import type { BotSdkContext, Route } from "../plugin";
import type { MessagingAccount, MessagingAdapter, MessagingUpdate } from "../channel/internal";
import { listenerAccount, markNeedsAttention } from "./conversation";
import { readBody } from "./routines";
import { receiveMessaging } from "./turn";

/*
 * The webhook routes of the messaging adapters whose platform only posts to a webhook (ticket
 * #1355), such as Telnyx: one per adapter, `POST <basePath>/channels/<platform>/<accountId>`, the
 * URL the owner gives the platform for that Channel account. The adapter reads the request, its
 * updates go into the inbound path a listener's take (`receiveMessaging`), and the route answers
 * once they are stored (#1363): the platform won't resend after a 2xx, so a 2xx before that could
 * lose them. Only storing is awaited; the Turn runs later, on the runner.
 */

/** How long a webhook update's id is remembered across instances, so a platform's retry is dropped. */
const seenMs = 24 * 60 * 60 * 1000;

/**
 * How long an update's id is held while it is stored, renewed for as long as the store runs. Short
 * so that a copy resent after a crash mid-store finds it lapsed and is stored: a second copy is better
 * than none. The two windows are how an id's state is told from one hit: one this short is being
 * stored, a longer one is done.
 */
const storingMs = 10 * 1000;

/** How often a running store renews its hold: often enough that a late renewal doesn't lose it. */
const renewMs = storingMs / 3;

/** A done id's window: `seenMs`, plus the end of it that a hit would read as being stored. */
const doneMs = seenMs + storingMs;

/** The largest request body a webhook route reads; a larger one is answered 413 unread. */
const bodyLimit = 256 * 1024;

const accountId = z.uuid();

/**
 * Each instance's webhook work still running, which the `channel` plugin's `stop` waits for. Kept
 * by its lifecycle, which every context over the instance's parts shares.
 */
const workBySdk = new WeakMap<BotSdkContext["lifecycle"], Set<Promise<void>>>();

/** Resolves once every webhook request of `sdk` has been answered, its updates stored. */
export async function settleWebhooks(sdk: BotSdkContext): Promise<void> {
  const work = workBySdk.get(sdk.lifecycle);
  while (work && work.size > 0) await Promise.all(work);
}

/** Keeps `running` until it settles, so `stop` can wait for it. It must not reject. */
function track(sdk: BotSdkContext, running: Promise<void>) {
  let work = workBySdk.get(sdk.lifecycle);
  if (!work) workBySdk.set(sdk.lifecycle, (work = new Set()));
  const kept = running.finally(() => work.delete(kept));
  work.add(kept);
}

/**
 * The webhook route of each adapter among `adapters` that declares `webhook`, whose notices link
 * into the app at `appUrl`. An account it doesn't have, on another platform, not active, or whose
 * credentials can't be read gets 404 (the last also marks it as needing attention); a body over
 * the limit gets 413, and a request the adapter refuses gets 400, storing nothing; an instance
 * that is stopping, an adapter that throws, or an update that couldn't be stored or is still being
 * stored elsewhere gets 503 so the platform retries. Any other gets 202 once each of its updates is
 * stored or deliberately dropped.
 */
export function messagingWebhookRoutes(
  adapters: readonly MessagingAdapter[],
  appUrl: string | null,
): Route[] {
  return adapters
    .filter((adapter) => adapter.webhook)
    .map((adapter) => ({
      method: "POST",
      path: `/channels/${adapter.id}/:account`,
      public: true,
      handle: async (request, { sdk, params }) => {
        if (sdk.lifecycle.stopping) return new Response("Try again later", { status: 503 });
        return answer(sdk, adapter, appUrl, request, params.account);
      },
    }));
}

/** Answers one webhook request: `messagingWebhookRoutes` says how. */
async function answer(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  appUrl: string | null,
  request: Request,
  id: string | undefined,
): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  const unavailable = () => new Response("Try again later", { status: 503 });
  if (!accountId.safeParse(id).success) return notFound();
  const found = await listenerAccount(sdk, id!);
  if (found?.platform !== adapter.id || found.status !== "active") return notFound();
  if (!found.account) {
    // No key of the keyring reads the credentials: only saving them again fixes it.
    await markNeedsAttention(sdk, id!, found.version, "The saved credentials can't be read");
    return notFound();
  }
  const body = await readBody(request, bodyLimit);
  if (body === null) return new Response("Payload too large", { status: 413 });
  // A stop that began while the body was read can't wait for this request, so it is turned away.
  // From here on the request is kept, so a stop waits for it to be checked and stored; a body that
  // never ends never holds it up.
  if (sdk.lifecycle.stopping) return unavailable();
  const { account: held, version } = found;
  const accepted = (async () => {
    const account = { ...held, platform: adapter.id };
    let read: Awaited<ReturnType<NonNullable<MessagingAdapter["webhook"]>>>;
    try {
      read = await adapter.webhook!(held, { headers: request.headers, body }, { fetch: sdk.fetch });
    } catch (error) {
      sdk.logger.error(`A ${adapter.id} webhook request couldn't be read`, error);
      return unavailable();
    }
    if ("rejected" in read) return new Response(read.rejected, { status: 400 });
    const stored = await storeAll(sdk, adapter, account, version, read.updates, appUrl);
    return stored ? new Response(null, { status: 202 }) : unavailable();
  })();
  track(
    sdk,
    accepted.then(
      () => undefined,
      () => undefined,
    ),
  );
  return accepted;
}

/**
 * Takes an update's id in the shared counters, so a copy is dropped wherever it lands: `mine` to store
 * it, `storing` when another attempt is at it now, `seen` when it is done. A claim that fails is
 * `mine`, since a second copy is better than none: the instance's own dedupe still catches a copy
 * it took.
 */
async function claim(
  sdk: BotSdkContext,
  platform: string,
  key: string,
): Promise<"mine" | "storing" | "seen"> {
  try {
    const { count, resetMs } = await sdk.counters.hit(key, storingMs);
    if (count === 1) return "mine";
    return resetMs > storingMs ? "seen" : "storing";
  } catch (error) {
    sdk.logger.error(`Claiming a ${platform} update's id failed`, error);
    return "mine";
  }
}

/** Replaces an id's window, and says whether it did. Never throws: its short window still lapses. */
async function settle(sdk: BotSdkContext, platform: string, key: string, windowMs?: number) {
  try {
    await sdk.counters.reset(key, windowMs);
    return true;
  } catch (error) {
    sdk.logger.error(`Settling a ${platform} update's id failed`, error);
    return false;
  }
}

/**
 * Runs `store` while renewing its hold on `key`, so a store that is only slow keeps the id and a
 * copy can't start a second one. Says when the hold was last renewed. Every renewal has landed by the
 * time this returns or throws, so none overwrites how the attempt then settles the id.
 */
async function holding(
  sdk: BotSdkContext,
  platform: string,
  key: string,
  store: () => Promise<void>,
): Promise<{ failure: { error: unknown } | null; heldAt: number }> {
  let heldAt = Date.now();
  let renewals = Promise.resolve();
  const timer = setInterval(() => {
    renewals = renewals.then(async () => {
      const at = Date.now();
      if (await settle(sdk, platform, key, storingMs)) heldAt = at;
    });
  }, renewMs);
  let failure: { error: unknown } | null = null;
  try {
    await store();
  } catch (error) {
    failure = { error };
  }
  clearInterval(timer);
  await renewals;
  return { failure, heldAt };
}

/**
 * Stores each update one at a time, as a listener does, and says whether all of them are done. An
 * update that fails lets go of its id, so its retry is taken, and the others still go in: the retry
 * then finds those seen. A copy another attempt is still storing isn't done: that attempt may yet
 * fail, and a 2xx here would end the platform's retries.
 */
async function storeAll(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  account: MessagingAccount & { platform: string },
  version: string,
  updates: MessagingUpdate[],
  appUrl: string | null,
): Promise<boolean> {
  // A rejected token marks the account; it takes no more requests until it is saved again.
  const onRejected = (reason: string) => markNeedsAttention(sdk, account.id, version, reason);
  let done = true;
  for (const update of updates) {
    const key = `channel-webhook:${account.platform}:${account.id}:${update.sourceId}`;
    const claimed = await claim(sdk, account.platform, key);
    if (claimed === "seen") {
      sdk.logger.debug?.(`A ${account.platform} update was dropped: it is a resent update`);
    } else if (claimed === "storing") {
      done = false;
    } else {
      const { failure, heldAt } = await holding(sdk, account.platform, key, () =>
        receiveMessaging(sdk, adapter, account, update, appUrl, onRejected, "webhook"),
      );
      if (failure) {
        sdk.logger.error(`A ${adapter.id} webhook update couldn't be stored`, failure.error);
        // Past its window the id is no longer this attempt's to let go of: another may hold it.
        if (Date.now() - heldAt < storingMs) await settle(sdk, account.platform, key);
        done = false;
      } else {
        await settle(sdk, account.platform, key, doneMs);
      }
    }
  }
  return done;
}
