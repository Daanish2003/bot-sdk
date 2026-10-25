import type { BotSdkContext, BotSdkPlugin, Transaction } from "../../../core/server/plugin";
import { type DeliveryPayload, deliverIn, sendDelivery } from "./deliver";
import type { EmailChannel } from "./email";
import { receiveEmail } from "./inbound";
import { channelRouter } from "./routers/index";

/** A Channel adapter (spec #761): its wire format only. Email is the one there is. */
export type ChannelAdapter = EmailChannel;

/** The core's Channels (`sdk.channels`, spec #871): the channels slot's adapters. */
export type ChannelApi = {
  /**
   * The inbound handler of Channel `channel`, Request → Response, which the Host mounts with no
   * sign-in (email: `POST /api/channels/email`). A mail the provider can't read gets 400; any mail
   * it can gets 202, whether it woke the Bot or was dropped, so a sender learns nothing. A Channel
   * with no adapter gets 404.
   */
  inbound: (channel: ChannelAdapter["id"], request: Request) => Promise<Response>;
  /** The email Channel's inbound domain. Throws when the Host gave no email adapter. */
  emailDomain: () => string;
  /**
   * The Bots' hook after they save a Bot Message, in the same transaction: when the reply goes by
   * email too (the Turn took an email, or the Bot speaks first and the user last wrote by email),
   * marks the Message emailed and enqueues its `channel.deliver` job. `turnId` is the Turn that
   * sent it, or `null` for a Message no Turn sent (a Helper's).
   */
  deliverIn: (
    tx: Transaction,
    sent: { conversationId: string; messageId: string; turnId: string | null },
  ) => Promise<void>;
  /** Sends one `channel.deliver` job's email; the runner retries it when it throws. */
  sendDelivery: (payload: DeliveryPayload) => Promise<void>;
};

/** How the Host sets up the Channels. */
export type ChannelOptions = {
  adapters: readonly ChannelAdapter[];
  /**
   * The user's verified account email, or `null` when they have none: only mail from it reaches
   * their Bots. The SDK knows users only by id, so the Host reads it from its auth.
   */
  verifiedEmail: (userId: string) => Promise<string | null>;
};

export type ChannelPlugin = BotSdkPlugin<"channel", never, never>;

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
      if (!email) throw new Error("The channels slot has no email adapter");
      return email.domain;
    },
    deliverIn: async (tx, sent) => {
      if (email) await deliverIn(sdk, tx, email, sent);
    },
    sendDelivery: async (payload) => {
      if (!email) throw new Error("The channels slot has no email adapter");
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
