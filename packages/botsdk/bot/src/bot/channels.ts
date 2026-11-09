import { channelAccountInput, saveChannelAccountInput } from "@botsdk/client/bot/channel-account";
import { botInput } from "@botsdk/client/bot/contract";
import { unlinkIdentityInput } from "@botsdk/client/bot/linked-identity";

import type { BotSdkContext, Route } from "../plugin";
import { parseInput } from "../rpc-error";
import { PermanentJobError } from "../runner/internal";
import {
  type ChannelApi,
  type ChannelOptions,
  type ChannelPlugin,
  CredentialsRejectedError,
  type EmailChannel,
  isMessagingAdapter,
  type MessagingAdapter,
  type WebPushChannel,
} from "../channel/internal";
import { channelRouter } from "./routers/channel";
import { accountsChanged, channelListeners } from "./channel-listeners";
import { messagingWebhookRoutes, settleWebhooks } from "./channel-webhooks";
import {
  channelAccountIdsOf,
  channelUserDelete,
  deliverIn,
  exportChannelData,
  issueLinkCode,
  listChannelAccounts,
  listenerAccount,
  listLinkedIdentities,
  markNeedsAttention,
  pageIn,
  removeChannelAccount,
  removeHeldChannelAccounts,
  rotateChannelAccountKeys,
  saveChannelAccount,
  saveHeldChannelAccount,
  sendDelivery,
  sendPage,
  setMessagingPlatforms,
  unlinkIdentity,
} from "./conversation";
import { receiveEmail } from "./turn";

/** The Channel ids the core gives its own Channels, which no messaging adapter may take. */
const reservedIds = new Set(["web", "email", "push"]);

/** The app URL messaging links open: the plugin's own, else the email or push adapter's. */
function appUrlOf({ adapters, appUrl }: ChannelOptions): string | null {
  const { email, push } = adaptersOf(adapters);
  const url = appUrl || (email ?? push)?.appUrl;
  return url?.replace(/\/+$/, "") || null;
}

/** The email, web push and messaging adapters among `adapters`. */
function adaptersOf(adapters: ChannelOptions["adapters"]) {
  const messaging: MessagingAdapter[] = [];
  let email: EmailChannel | undefined;
  let push: WebPushChannel | undefined;
  for (const adapter of adapters) {
    if (isMessagingAdapter(adapter)) messaging.push(adapter);
    else if (adapter.id === "email") email ??= adapter;
    else if (adapter.id === "push") push ??= adapter as WebPushChannel;
  }
  return { email, push, messaging };
}

/**
 * The Channels over `adapters`: what `sdk.channels` is. With no adapter, the Bots talk on the web
 * only: `receive` throws and no reply goes out by email or web push.
 */
export function createChannels(sdk: BotSdkContext, options: ChannelOptions): ChannelApi {
  const { adapters, verifiedEmail } = options;
  const { email, push, messaging } = adaptersOf(adapters);
  const appUrl = appUrlOf(options);
  const channels: ChannelApi = {
    receive: async (id, mail) => {
      if (id !== "email" || !email) throw new Error("The channel plugin has no email adapter");
      await receiveEmail(sdk, { channel: email, verifiedEmail }, mail);
    },
    emailDomain: () => {
      if (!email) throw new Error("The channel plugin has no email adapter");
      return email.domain;
    },
    deliverIn: async (tx, sent) => {
      if (email || push || messaging.length > 0) {
        await deliverIn(sdk, tx, { email, push, messaging }, sent);
      }
    },
    sendDelivery: async (payload) => {
      await sendDelivery(sdk, { email, push, messaging }, verifiedEmail, payload, appUrl);
    },
    pageIn: (tx, page) => pageIn(sdk, tx, { email, push, messaging }, page),
    sendPage: (payload) =>
      sendPage(sdk, { email, push, messaging }, verifiedEmail, appUrl, payload),
    pushKey: () => push?.provider.publicKey ?? null,
    accounts: {
      list: ({ userId, ...rest }) =>
        listChannelAccounts(sdk, messaging, { userId, ...parseInput(botInput, rest) }),
      save: async ({ userId, ...rest }) => {
        const input = { userId, ...parseInput(saveChannelAccountInput, rest) };
        const { row, changed } = await saveChannelAccount(sdk, messaging, input);
        await accountsChanged(sdk, changed);
        return row;
      },
      remove: async ({ userId, ...rest }) => {
        const input = { userId, ...parseInput(channelAccountInput, rest) };
        await accountsChanged(sdk, await removeChannelAccount(sdk, messaging, input));
      },
    },
    saveHeldAccount: async (input) => {
      const { row, changed } = await saveHeldChannelAccount(sdk, messaging, {
        ...input,
        ...parseInput(saveHeldChannelAccountInput, input),
      });
      await accountsChanged(sdk, changed);
      return row;
    },
    sendHeld: async (id, message) => {
      const found = await listenerAccount(sdk, id);
      const adapter = messaging.find((candidate) => candidate.id === found?.platform);
      if (!found || found.botId !== null || !adapter) {
        throw new PermanentJobError("No messaging adapter sends for that held Channel account");
      }
      if (!found.account) {
        throw new PermanentJobError("The Channel account's credentials can't be read");
      }
      try {
        await adapter.send(found.account, message, { fetch: sdk.fetch });
      } catch (error) {
        if (!(error instanceof CredentialsRejectedError)) throw error;
        await markNeedsAttention(sdk, id, found.version, error.reason);
        await accountsChanged(sdk, [id]);
        throw new PermanentJobError(error.message);
      }
    },
    heldCredentials: async (id) => {
      const found = await listenerAccount(sdk, id);
      return found && found.botId === null ? (found.account?.credentials ?? null) : null;
    },
    sendEmail: async (mail) => {
      if (!email) throw new PermanentJobError("The channel plugin has no email adapter");
      await email.provider.send(mail);
    },
    reach: (platform) => {
      if (platform === "email") return email ? { canStartConversation: true } : undefined;
      const adapter = messaging.find((candidate) => candidate.id === platform);
      if (!adapter) return undefined;
      const { canStartConversation, replyWindowHours, maxLength, cutsLongMessages } = adapter;
      return { canStartConversation, replyWindowHours, maxLength, cutsLongMessages };
    },
    platforms: () =>
      messaging.map((adapter) => ({
        platform: adapter.id,
        fields: [...adapter.credentialFields],
        plainFields: [...(adapter.plainCredentialFields ?? [])],
      })),
    webhookUrl: (platform, accountId) => {
      const adapter = messaging.find((candidate) => candidate.id === platform);
      const base = sdk.liveView.base;
      if (!adapter?.webhook || appUrl === null || base === null) return null;
      return `${appUrl}${base}/channels/${platform}/${accountId}`;
    },
    identities: {
      list: ({ userId }) => listLinkedIdentities(sdk, messaging, userId),
      unlink: ({ userId, ...rest }) =>
        unlinkIdentity(sdk, messaging, { userId, ...parseInput(unlinkIdentityInput, rest) }),
      linkCode: ({ userId }) => issueLinkCode(sdk, messaging, userId),
    },
  };
  setMessagingPlatforms(
    channels,
    messaging.map((adapter) => adapter.id),
  );
  return channels;
}

/** What a feature's `needs: ["channelAccounts"]` gives it: the accounts it holds (ticket #1331). */
export type ChannelAccountsService = {
  /**
   * Adds or fixes an account the feature holds, once the platform accepts its credentials, and starts
   * its listener. `hold` records the feature's holder in the save's transaction. A platform bot on one
   * of the user's Bots moves here. One on another user's holder is refused with CONFLICT, and
   * credentials the platform rejects with BAD_REQUEST.
   */
  save: ChannelApi["saveHeldAccount"];
  /** Deletes accounts the feature holds, in the caller's transaction. Call `changed` once it commits. */
  removeIn: typeof removeHeldChannelAccounts;
  /** Tells the listeners that these accounts changed. Never throws. */
  changed: (ids: readonly string[]) => Promise<void>;
  /**
   * Sends text through account `id`, which the feature holds, from one of its jobs: any other throw is
   * for the runner to retry, and `MessagingSendError`'s progress, kept and passed back as `resume`, sends
   * only the parts after it. Credentials the platform rejects mark the account as needing attention,
   * stop its listener and throw `PermanentJobError`, as nothing will send until they're saved again.
   */
  send: ChannelApi["sendHeld"];
  /** The decrypted credentials of account `id`, which a feature holds; null when there is none or it is a Bot's. */
  credentialsOf: ChannelApi["heldCredentials"];
  /** What `platform`'s adapter declares it limits; undefined when the Host has no such adapter. */
  reach: ChannelApi["reach"];
  /** Each messaging platform the Host offers, with the credential fields an account on it takes. */
  platforms: ChannelApi["platforms"];
  /** The URL a webhook platform posts an account's updates to, or null. See `ChannelApi`. */
  webhookUrl: ChannelApi["webhookUrl"];
  /** Sends one mail through the email Channel, from an address the feature gives out (spec #1176). */
  sendEmail: ChannelApi["sendEmail"];
  /** The domain the email Channel receives mail for, where a feature's addresses go; null without one. */
  emailDomain: () => string | null;
};

/** The `channelAccounts` core service, over whichever Channels the instance ends up with. */
export const channelAccountsService = (sdk: BotSdkContext): ChannelAccountsService => ({
  save: (input) => sdk.channels.saveHeldAccount(input),
  removeIn: removeHeldChannelAccounts,
  changed: (ids) => accountsChanged(sdk, ids),
  send: (id, message) => sdk.channels.sendHeld(id, message),
  credentialsOf: (id) => sdk.channels.heldCredentials(id),
  reach: (platform) => sdk.channels.reach(platform),
  platforms: () => sdk.channels.platforms(),
  webhookUrl: (platform, accountId) => sdk.channels.webhookUrl(platform, accountId),
  sendEmail: (mail) => sdk.channels.sendEmail(mail),
  emailDomain: () => {
    // `sdk.channels.emailDomain` throws only when the Host gave no email adapter.
    try {
      return sdk.channels.emailDomain();
    } catch {
      return null;
    }
  },
});

/** Adds or fixes a Channel account a feature holds (ticket #1331): a Bot's save, with no Bot. */
const saveHeldChannelAccountInput = saveChannelAccountInput.omit({ botId: true });

/**
 * The Channels besides web (spec #761) that the user talks to their Bots on, each an adapter, as
 * the core's `sdk.channels` with their router. It owns turning an inbound into a Trigger, the
 * sender check and dedupe, runs the messaging Channel accounts' listeners while the SDK runs
 * (spec #1044), and serves the webhook route of each messaging adapter that has one (ticket #1355).
 */
export function channel(options: ChannelOptions): ChannelPlugin {
  const { messaging } = adaptersOf(options.adapters);
  const appUrl = appUrlOf(options);
  const platforms = new Set<string>();
  for (const adapter of messaging) {
    if (reservedIds.has(adapter.id) || platforms.has(adapter.id)) {
      throw new Error(`The messaging adapter id "${adapter.id}" is taken`);
    }
    if (adapter.listen && adapter.webhook) {
      throw new Error(`The messaging adapter "${adapter.id}" declares both listen and webhook`);
    }
    platforms.add(adapter.id);
  }
  // Each instance the plugin is composed into runs, and stops, its own listeners.
  const listeners = new WeakMap<BotSdkContext, ReturnType<typeof channelListeners>>();
  return {
    id: "channel",
    router: { channels: channelRouter },
    routes: [...emailInboundRoutes(options.adapters), ...messagingWebhookRoutes(messaging, appUrl)],
    init: (sdk) => {
      sdk.channels = createChannels(sdk, options);
    },
    start: async (sdk) => {
      let own = listeners.get(sdk);
      if (!own) listeners.set(sdk, (own = channelListeners(sdk, messaging, appUrl)));
      await own.start();
    },
    stop: async (sdk) => {
      await listeners.get(sdk)?.stop();
      await settleWebhooks(sdk);
    },
    rotateKeys: (sdk) => rotateChannelAccountKeys(sdk),
    deleteUser: channelUserDelete,
    exportUser: (_sdk, userId, tx) => exportChannelData(tx, userId),
    databaseHooks: {
      conversation: {
        delete: {
          // A Bot goes with its Conversation, and its Channel accounts with it.
          before: (_sdk, { conversationIds, tx }) => channelAccountIdsOf(tx, conversationIds),
          after: (sdk, { collected }) => accountsChanged(sdk, collected as string[]),
        },
      },
    },
  };
}

/** No Channel besides web (no channels slot): only the email inbound route, which answers 404. */
export function noChannels(): ChannelPlugin {
  return {
    id: "channel",
    routes: emailInboundRoutes([]),
    // Rows a Host left behind when it dropped its adapters still go with the user.
    deleteUser: channelUserDelete,
    exportUser: (_sdk, userId, tx) => exportChannelData(tx, userId),
  };
}

/**
 * The email Channel's inbound route, `POST <basePath>/channels/email`, where its provider posts
 * mail, with no sign-in: the SDK checks the sender. A mail the provider can't read gets 400; any
 * mail it can gets 202, whether it woke the Bot or was dropped, so a sender learns nothing. Without
 * an email adapter, every inbound gets 404.
 */
function emailInboundRoutes(adapters: ChannelOptions["adapters"]): Route[] {
  const { email } = adaptersOf(adapters);
  return [
    {
      method: "POST",
      path: "/channels/email",
      public: true,
      handle: async (request, { sdk }) => {
        if (!email) return new Response("Not found", { status: 404 });
        const mail = await email.provider.parseInbound(request);
        if ("rejected" in mail) return new Response(mail.rejected, { status: 400 });
        await sdk.channels.receive("email", mail);
        return new Response(null, { status: 202 });
      },
    },
  ];
}
