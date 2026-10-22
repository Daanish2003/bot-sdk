import type { BotSdkPlugin, Transaction } from "../../../core/server/plugin";
import { type DeliveryPayload, deliverIn, sendDelivery } from "./deliver";
import type { EmailChannel } from "./email";
import { receiveEmail } from "./inbound";
import { channelRouter } from "./routers/index";

/** A Channel adapter (spec #761): its wire format only. Email is the one there is. */
export type ChannelAdapter = EmailChannel;

/** The `channel` plugin's API (`sdk.plugin("channel")`). */
export type ChannelApi = {
  /**
   * The inbound handler of Channel `channel`, Request → Response, which the Host mounts with no
   * sign-in (email: `POST /api/channels/email`). A mail the provider can't read gets 400; any mail
   * it can gets 202, whether it woke the Bot or was dropped, so a sender learns nothing.
   */
  inbound: (channel: ChannelAdapter["id"], request: Request) => Promise<Response>;
  /** The email Channel's inbound domain. Throws when the Host gave no email adapter. */
  emailDomain: () => string;
  /**
   * The `bot` plugin's hook after it saves a Bot Message, in the same transaction: when the reply
   * goes by email too (the Turn took an email, or the Bot speaks first and the user last wrote by
   * email), marks the Message emailed and enqueues its `channel.deliver` job. `turnId` is the Turn
   * that sent it, or `null` for a Message no Turn sent (a Helper's).
   */
  deliverIn: (
    tx: Transaction,
    sent: { conversationId: string; messageId: string; turnId: string | null },
  ) => Promise<void>;
  /** Sends one `channel.deliver` job's email; the runner retries it when it throws. */
  sendDelivery: (payload: DeliveryPayload) => Promise<void>;
};

/** How the Host sets up the `channel` plugin. */
export type ChannelOptions = {
  adapters: readonly ChannelAdapter[];
  /**
   * The user's verified account email, or `null` when they have none: only mail from it reaches
   * their Bots. The SDK knows users only by id, so the Host reads it from its auth.
   */
  verifiedEmail: (userId: string) => Promise<string | null>;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    channel: ChannelApi;
  }
}

export type ChannelPlugin = BotSdkPlugin<"channel", never, never>;

/**
 * The `channel` plugin (spec #761, ADR 0020): the Channels besides web that the user talks to their
 * Bots on, each an adapter. It owns turning an inbound into a Trigger, the sender check and dedupe.
 */
export function channel({ adapters, verifiedEmail }: ChannelOptions): ChannelPlugin {
  const email = adapters.find((adapter) => adapter.id === "email");
  return {
    id: "channel",
    requires: ["models", "bot", "runner"],
    router: { channel: channelRouter },
    init: (sdk) => {
      const api: ChannelApi = {
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
      return { api };
    },
  };
}
