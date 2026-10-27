import { z } from "zod";

import type { BotSdkPlugin, Transaction } from "../plugin";
import type { EmailChannel, InboundMail } from "./email";

/** What a `channel.deliver` job carries: the headers fixed when the Message was saved. */
export const deliveryPayload = z.object({
  messageId: z.uuid(),
  subject: z.string(),
  inReplyTo: z.string().optional(),
});

export type DeliveryPayload = z.infer<typeof deliveryPayload>;

/** A Channel adapter (spec #761): its wire format only. Email is the one there is. */
export type ChannelAdapter = EmailChannel;

/** The core's Channels (`sdk.channels`, spec #871): the channels slot's adapters. */
export type ChannelApi = {
  /**
   * Takes one inbound message of Channel `channel`, as its provider parsed it (email: an
   * `InboundMail`), for a Host that receives it on its own route; the HTTP layer serves
   * `POST <basePath>/channels/email` over it. It wakes the Bot only for its user's verified email
   * with a DMARC pass, and drops anything else silently. Throws with no adapter for `channel`.
   */
  receive: (channel: ChannelAdapter["id"], mail: InboundMail) => Promise<void>;
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
