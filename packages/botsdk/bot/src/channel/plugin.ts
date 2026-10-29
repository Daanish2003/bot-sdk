import { z } from "zod";

import type { BotSdkPlugin, Transaction } from "../plugin";
import type { EmailChannel, InboundMail } from "./email";
import type { WebPushChannel } from "./push";

/**
 * What a `channel.deliver` job carries: for email, the headers fixed when the Message was saved
 * (a job queued before web push has no `channel`, and is email); for web push, the Message alone.
 */
export const deliveryPayload = z.union([
  z.object({ channel: z.literal("push"), messageId: z.uuid() }),
  z.object({
    channel: z.literal("email").optional(),
    messageId: z.uuid(),
    subject: z.string(),
    inReplyTo: z.string().optional(),
  }),
]);

export type DeliveryPayload = z.infer<typeof deliveryPayload>;

/** A Channel adapter (spec #761): its wire format only. Email (spec #761) and web push (spec #1024). */
export type ChannelAdapter = EmailChannel | WebPushChannel;

/** The core's Channels (`sdk.channels`, spec #871): the channels slot's adapters. */
export type ChannelApi = {
  /**
   * Takes one inbound message of Channel `channel`, as its provider parsed it (email: an
   * `InboundMail`), for a Host that receives it on its own route; the HTTP layer serves
   * `POST <basePath>/channels/email` over it. It wakes the Bot only for its user's verified email
   * with a DMARC pass, and drops anything else silently. Throws with no adapter for `channel`.
   */
  receive: (channel: EmailChannel["id"], mail: InboundMail) => Promise<void>;
  /** The email Channel's inbound domain. Throws when the Host gave no email adapter. */
  emailDomain: () => string;
  /**
   * The Bots' hook after they save a Bot Message, in the same transaction: when the reply goes by
   * email too (the Turn took an email, or the Bot speaks first and the user's notification
   * settings say so), marks the Message emailed and enqueues its `channel.deliver` job; when it is
   * pushed, enqueues its push job. `turnId` is the Turn that
   * sent it, or `null` for a Message no Turn sent (a Helper's).
   */
  deliverIn: (
    tx: Transaction,
    sent: { conversationId: string; messageId: string; turnId: string | null; urgent: boolean },
  ) => Promise<void>;
  /**
   * Sends one `channel.deliver` job's email, or its pushes to each of the user's devices; the
   * runner retries it when it throws.
   */
  sendDelivery: (payload: DeliveryPayload) => Promise<void>;
  /** The web push Channel's VAPID public key, or `null` when the Host gave no web push adapter. */
  pushKey: () => string | null;
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
