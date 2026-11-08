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

/** Each instance's accepted work still running, which the `channel` plugin's `stop` waits for. */
const workBySdk = new WeakMap<BotSdkContext, Set<Promise<void>>>();

/** Resolves once every accepted webhook request of `sdk` has been handed in or dropped. */
export async function settleWebhooks(sdk: BotSdkContext): Promise<void> {
  const work = workBySdk.get(sdk);
  while (work && work.size > 0) await Promise.all(work);
}

/** Runs `task` after the response, kept until it settles, so `stop` can wait for it. */
function afterResponse(sdk: BotSdkContext, task: () => Promise<void>) {
  let work = workBySdk.get(sdk);
  if (!work) workBySdk.set(sdk, (work = new Set()));
  const running = task().finally(() => work.delete(running));
  work.add(running);
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
        const notFound = () => new Response("Not found", { status: 404 });
        const unavailable = () => new Response("Try again later", { status: 503 });
        if (sdk.lifecycle.stopping) return unavailable();
        if (!accountId.safeParse(params.account).success) return notFound();
        const found = await listenerAccount(sdk, params.account!);
        if (found?.platform !== adapter.id || found.status !== "active") return notFound();
        if (!found.account) {
          // No key of the keyring reads the credentials: only saving them again fixes it.
          await markNeedsAttention(
            sdk,
            params.account!,
            found.version,
            "The saved credentials can't be read",
          );
          return notFound();
        }
        const body = await readBody(request, bodyLimit);
        if (body === null) return new Response("Payload too large", { status: 413 });
        const account = { ...found.account, platform: adapter.id };
        let read: Awaited<ReturnType<NonNullable<MessagingAdapter["webhook"]>>>;
        try {
          read = await adapter.webhook!(
            found.account,
            { headers: request.headers, body },
            { fetch: sdk.fetch },
          );
        } catch (error) {
          sdk.logger.error(`A ${adapter.id} webhook request couldn't be read`, error);
          return unavailable();
        }
        if ("rejected" in read) return new Response(read.rejected, { status: 400 });
        const fresh = await unseen(sdk, account, read.updates);
        afterResponse(sdk, () => handIn(sdk, adapter, account, found.version, fresh, appUrl));
        return new Response(null, { status: 202 });
      },
    }));
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
