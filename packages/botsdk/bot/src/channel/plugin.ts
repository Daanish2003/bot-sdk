import type { ChannelAccountRow } from "@botsdk/client/bot/channel-account";
import type { LinkCode, LinkedIdentityRow } from "@botsdk/client/bot/linked-identity";
import { z } from "zod";

import type { BotSdkPlugin, Transaction } from "../plugin";
import type { EmailChannel, InboundMail } from "./email";
import type { MessagingAdapter } from "./messaging";
import type { WebPushChannel } from "./push";

/**
 * What a `channel.deliver` job carries: for email, the headers fixed when the Message was saved
 * (a job queued before web push has no `channel`, and is email); for web push, the Message alone;
 * for a messaging Channel, the platform and the Message.
 */
export const deliveryPayload = z.union([
  z.object({ channel: z.literal("push"), messageId: z.uuid() }),
  z.object({ channel: z.literal("messaging"), platform: z.string(), messageId: z.uuid() }),
  z.object({
    channel: z.literal("email").optional(),
    messageId: z.uuid(),
    subject: z.string(),
    inReplyTo: z.string().optional(),
  }),
]);

export type DeliveryPayload = z.infer<typeof deliveryPayload>;

/**
 * A Channel adapter (spec #761): its wire format only. Email (spec #761), web push (spec #1024) and
 * the messaging adapters (spec #1044), one per platform.
 */
export type ChannelAdapter = EmailChannel | WebPushChannel | MessagingAdapter;

/** The Bot's Channel account on a platform, as the domain methods take it. */
type AccountInput = { userId: string; botId: string; platform: string };

/**
 * The Channel accounts of the user's Bots (spec #1044), one per Bot and messaging platform. Every
 * method throws NOT_FOUND when the slot has no messaging adapter, or the Bot isn't the user's.
 */
export type ChannelAccountsApi = {
  /** Each messaging platform the Host offers, with the Bot's Channel account there, if any. */
  list: (input: { userId: string; botId: string }) => Promise<ChannelAccountRow[]>;
  /**
   * Adds or fixes the Bot's Channel account on `platform` once the platform accepts
   * `credentials`, and starts its listener; a rejection throws BAD_REQUEST and saves nothing. A
   * platform bot on another of the user's Bots moves to this one; one on another user's Bot is
   * refused with CONFLICT.
   */
  save: (
    input: AccountInput & { credentials: Record<string, string> },
  ) => Promise<ChannelAccountRow>;
  /** Removes the Bot's Channel account on `platform` and stops its listener. */
  remove: (input: AccountInput) => Promise<void>;
};

/**
 * The user's Linked identities and link codes (spec #1044). Every method throws NOT_FOUND when the
 * slot has no messaging adapter.
 */
export type LinkedIdentitiesApi = {
  /** The user's Linked identities, one per platform. */
  list: (input: { userId: string }) => Promise<LinkedIdentityRow[]>;
  /** Unlinks the user's Linked identity on `platform` at once. */
  unlink: (input: { userId: string; platform: string }) => Promise<void>;
  /**
   * Issues a link code (6 digits, valid 10 minutes, single use), replacing the user's live one,
   * with the deep links of their Bots' active Channel accounts.
   */
  linkCode: (input: { userId: string }) => Promise<LinkCode>;
};

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
   * pushed, or the reply goes back to a messaging Channel (the Turn took a Trigger from it, or the
   * notification settings name it), enqueues its job. `turnId` is the Turn that
   * sent it, or `null` for a Message no Turn sent (a Helper's).
   */
  deliverIn: (
    tx: Transaction,
    sent: { conversationId: string; messageId: string; turnId: string | null; urgent: boolean },
  ) => Promise<void>;
  /**
   * Sends one `channel.deliver` job's email, its pushes to each of the user's devices, or its text
   * on a messaging Channel; the runner retries it when it throws.
   */
  sendDelivery: (payload: DeliveryPayload) => Promise<void>;
  /** The web push Channel's VAPID public key, or `null` when the Host gave no web push adapter. */
  pushKey: () => string | null;
  /** The Channel accounts on the messaging Channels (spec #1044). */
  accounts: ChannelAccountsApi;
  /** The user's Linked identities on the messaging Channels (spec #1044). */
  identities: LinkedIdentitiesApi;
};

/** How the Host sets up the Channels. */
export type ChannelOptions = {
  adapters: readonly ChannelAdapter[];
  /**
   * The user's verified account email, or `null` when they have none: only mail from it reaches
   * their Bots. The SDK knows users only by id, so the Host reads it from its auth.
   */
  verifiedEmail: (userId: string) => Promise<string | null>;
  /**
   * The Host app's URL, without a trailing slash: a messaging Channel's links open
   * `<appUrl>/bots/<botId>`. Unset, the email or web push adapter's own `appUrl` is used; with
   * neither, a messaging Channel writes no links.
   */
  appUrl?: string;
};

export type ChannelPlugin = BotSdkPlugin<"channel", never, never>;
