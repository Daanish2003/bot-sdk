import { channelAccountInput, saveChannelAccountInput } from "@botsdk/client/bot/channel-account";
import { botInput } from "@botsdk/client/bot/contract";
import { unlinkIdentityInput } from "@botsdk/client/bot/linked-identity";

import type { BotSdkContext, Route } from "../plugin";
import { parseInput } from "../rpc-error";
import {
  type ChannelApi,
  type ChannelOptions,
  type ChannelPlugin,
  type EmailChannel,
  isMessagingAdapter,
  type MessagingAdapter,
  type WebPushChannel,
} from "../channel/internal";
import { channelRouter } from "./routers/channel";
import { accountsChanged, channelListeners } from "./channel-listeners";
import {
  channelAccountIdsOf,
  channelUserDelete,
  deliverIn,
  exportChannelData,
  issueLinkCode,
  listChannelAccounts,
  listLinkedIdentities,
  removeChannelAccount,
  rotateChannelAccountKeys,
  saveChannelAccount,
  sendDelivery,
  setMessagingPlatforms,
  unlinkIdentity,
} from "./conversation";
import { receiveEmail } from "./turn";

/** The Channel ids the core gives its own Channels, which no messaging adapter may take. */
const reservedIds = new Set(["web", "email", "push"]);

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
export function createChannels(
  sdk: BotSdkContext,
  { adapters, verifiedEmail }: ChannelOptions,
): ChannelApi {
  const { email, push, messaging } = adaptersOf(adapters);
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
      await sendDelivery(sdk, { email, push, messaging }, verifiedEmail, payload);
    },
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

/**
 * The Channels besides web (spec #761) that the user talks to their Bots on, each an adapter, as
 * the core's `sdk.channels` with their router. It owns turning an inbound into a Trigger, the
 * sender check and dedupe, and runs the messaging Channel accounts' listeners while the SDK runs
 * (spec #1044).
 */
export function channel(options: ChannelOptions): ChannelPlugin {
  const { messaging, email, push } = adaptersOf(options.adapters);
  const appUrl = (email ?? push)?.appUrl ?? null;
  const platforms = new Set<string>();
  for (const adapter of messaging) {
    if (reservedIds.has(adapter.id) || platforms.has(adapter.id)) {
      throw new Error(`The messaging adapter id "${adapter.id}" is taken`);
    }
    platforms.add(adapter.id);
  }
  // Each instance the plugin is composed into runs, and stops, its own listeners.
  const listeners = new WeakMap<BotSdkContext, ReturnType<typeof channelListeners>>();
  return {
    id: "channel",
    router: { channels: channelRouter },
    routes: emailInboundRoutes(options.adapters),
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
