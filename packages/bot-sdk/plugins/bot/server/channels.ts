import type { BotSdkContext } from "../../../core/server/plugin";
import type { ChannelApi, ChannelOptions, ChannelPlugin } from "../../channel/server/internal";
import { channelRouter } from "./routers/channel";
import { deliverIn, sendDelivery } from "./conversation";
import { receiveEmail } from "./turn";

/**
 * The Channels over `adapters`: what `sdk.channels` is. With no adapter, the Bots talk on the web
 * only: every inbound answers 404 and no reply goes out by email.
 */
export function createChannels(
  sdk: BotSdkContext,
  { adapters, verifiedEmail }: ChannelOptions,
): ChannelApi {
  const email = adapters.find((adapter) => adapter.id === "email");
  return {
    inbound: async (id, request) => {
      if (id !== "email" || !email) return new Response("Not found", { status: 404 });
      return receiveEmail(sdk, { channel: email, verifiedEmail }, request);
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
    init: (sdk) => {
      sdk.channels = createChannels(sdk, options);
    },
  };
}
