import { z } from "zod";

import type { BotSdkContext, Route } from "../plugin";
import type { MessagingAccount, MessagingAdapter, MessagingUpdate } from "../channel/internal";
import { listenerAccount, markNeedsAttention } from "./conversation";
import { readBody } from "./routines";
import { receiveMessaging } from "./turn";

/*
 * The webhook routes of the messaging adapters whose platform only posts to a webhook (ticket
 * #1355), such as Telnyx: one per adapter, `POST <basePath>/channels/<platform>/<accountId>`, the
 * URL the owner gives the platform for that Channel account. The route answers once the adapter
 * accepts the request, and its updates then go into the inbound path a listener's take
 * (`receiveMessaging`), so a platform that wants an answer within seconds gets one.
 */

/** How long a webhook update's id is remembered across instances, so a platform's retry is dropped. */
const seenMs = 24 * 60 * 60 * 1000;

/** The largest request body a webhook route reads; a larger one is answered 413 unread. */
const bodyLimit = 256 * 1024;

const accountId = z.uuid();

/**
 * Each instance's webhook work still running, which the `channel` plugin's `stop` waits for. Kept
 * by its lifecycle, which every context over the instance's parts shares.
 */
const workBySdk = new WeakMap<BotSdkContext["lifecycle"], Set<Promise<void>>>();

/** Resolves once every webhook request of `sdk` has been answered and its updates handed in. */
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
 * that is stopping, or an adapter that throws, gets 503 so the platform retries. Any other gets
 * 202, whether its updates woke anyone or were dropped.
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
  // From here on the request is kept, so a stop waits for it to be checked and handed in; a body that
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
    const fresh = await unseen(sdk, account, read.updates);
    // The work runs after the response, kept while it does.
    track(sdk, handIn(sdk, adapter, account, version, fresh, appUrl));
    return new Response(null, { status: 202 });
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
 * The updates whose ids no instance took lately: each claims its id in the shared counters, so a
 * platform's retry is dropped wherever it lands. A claim that fails keeps its update, since a
 * second copy is better than none: the instance's own dedupe still catches a copy it took.
 */
async function unseen(
  sdk: BotSdkContext,
  account: MessagingAccount & { platform: string },
  updates: MessagingUpdate[],
): Promise<MessagingUpdate[]> {
  const claimed = await Promise.all(
    updates.map(async (update) => {
      const key = `channel-webhook:${account.platform}:${account.id}:${update.sourceId}`;
      try {
        return (await sdk.counters.hit(key, seenMs)).count === 1;
      } catch (error) {
        sdk.logger.error(`Claiming a ${account.platform} update's id failed`, error);
        return true;
      }
    }),
  );
  const fresh = updates.filter((_update, index) => claimed[index]);
  if (fresh.length < updates.length) {
    sdk.logger.debug?.(`A ${account.platform} update was dropped: it is a resent update`);
  }
  return fresh;
}

/** Hands each update in, one at a time as a listener does. Never throws: a failure is logged. */
async function handIn(
  sdk: BotSdkContext,
  adapter: MessagingAdapter,
  account: MessagingAccount & { platform: string },
  version: string,
  updates: MessagingUpdate[],
  appUrl: string | null,
): Promise<void> {
  // A rejected token marks the account; it takes no more requests until it is saved again.
  const onRejected = (reason: string) => markNeedsAttention(sdk, account.id, version, reason);
  for (const update of updates) {
    try {
      await receiveMessaging(sdk, adapter, account, update, appUrl, onRejected);
    } catch (error) {
      sdk.logger.error(`A ${adapter.id} webhook update was dropped`, error);
    }
  }
}
