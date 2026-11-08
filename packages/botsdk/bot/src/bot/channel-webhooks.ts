import type { BotSdkContext, Route } from "../plugin";
import type { MessagingAccount, MessagingAdapter, MessagingUpdate } from "../channel/internal";
import { listenerAccount, markNeedsAttention } from "./conversation";
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
 * credentials can't be read gets 404; a request the adapter refuses gets 400 and stores nothing;
 * any other gets 202, whether its updates woke anyone or were dropped.
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
        const found = await listenerAccount(sdk, params.account!);
        if (found?.platform !== adapter.id || found.status !== "active" || !found.account) {
          return new Response("Not found", { status: 404 });
        }
        const account = { ...found.account, platform: adapter.id };
        const read = await adapter.webhook!(
          found.account,
          { headers: request.headers, body: await request.text() },
          { fetch: sdk.fetch },
        );
        if ("rejected" in read) return new Response(read.rejected, { status: 400 });
        const fresh = await unseen(sdk, account, read.updates);
        afterResponse(sdk, () => handIn(sdk, adapter, account, found.version, fresh, appUrl));
        return new Response(null, { status: 202 });
      },
    }));
}

/**
 * The updates whose ids no instance took lately: each claims its id in the shared counters, so a
 * platform's retry is dropped wherever it lands.
 */
async function unseen(
  sdk: BotSdkContext,
  account: MessagingAccount & { platform: string },
  updates: MessagingUpdate[],
): Promise<MessagingUpdate[]> {
  const fresh: MessagingUpdate[] = [];
  for (const update of updates) {
    const key = `channel-webhook:${account.platform}:${account.id}:${update.sourceId}`;
    if ((await sdk.counters.hit(key, seenMs)).count === 1) fresh.push(update);
    else sdk.logger.debug?.(`A ${account.platform} update was dropped: it is a resent update`);
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
