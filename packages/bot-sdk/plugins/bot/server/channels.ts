import type { BotSdkContext, Route } from "../../../core/server/plugin";
import type { ChannelApi, ChannelOptions, ChannelPlugin } from "../../channel/server/internal";
import { channelRouter } from "./routers/channel";
import { deliverIn, sendDelivery } from "./conversation";
import { receiveEmail } from "./turn";

/**
 * The Channels over `adapters`: what `sdk.channels` is. With no adapter, the Bots talk on the web
 * only: `receive` throws and no reply goes out by email.
 */
export function createChannels(
  sdk: BotSdkContext,
  { adapters, verifiedEmail }: ChannelOptions,
): ChannelApi {
  const email = adapters.find((adapter) => adapter.id === "email");
  return {
    receive: async (id, mail) => {
      if (id !== "email" || !email) throw new Error("The channel plugin has no email adapter");
      await receiveEmail(sdk, { channel: email, verifiedEmail }, mail);
    },
    emailDomain: () => {
      if (!email) throw new Error("The channel plugin has no email adapter");
      return email.domain;
    },
    deliverIn: async (tx, sent) => {
      if (email) await deliverIn(sdk, tx, email, sent);
    },
    sendDelivery: async (payload) => {
      if (!email) throw new Error("The channel plugin has no email adapter");
      await sendDelivery(sdk, email, verifiedEmail, payload);
    },
  };
}

/**
 * The Channels besides web (spec #761) that the user talks to their Bots on, each an adapter, as
 * the core's `sdk.channels` with their router. It owns turning an inbound into a Trigger, the
 * sender check and dedupe.
 */
export function channel(options: ChannelOptions): ChannelPlugin {
  return {
    id: "channel",
    router: { channel: channelRouter },
    routes: emailInboundRoutes(options.adapters),
    init: (sdk) => {
      sdk.channels = createChannels(sdk, options);
    },
  };
}

/**
 * The email Channel's inbound route, `POST <basePath>/channels/email`, where its provider posts
 * mail, with no sign-in: the SDK checks the sender. A mail the provider can't read gets 400; any
 * mail it can gets 202, whether it woke the Bot or was dropped, so a sender learns nothing. None
 * without an email adapter.
 */
function emailInboundRoutes(adapters: ChannelOptions["adapters"]): Route[] {
  const email = adapters.find((adapter) => adapter.id === "email");
  if (!email) return [];
  return [
    {
      method: "POST",
      path: "/channels/email",
      public: true,
      handle: async (request, { sdk }) => {
        const mail = await email.provider.parseInbound(request);
        if ("rejected" in mail) return new Response(mail.rejected, { status: 400 });
        await sdk.channels.receive("email", mail);
        return new Response(null, { status: 202 });
      },
    },
  ];
}
