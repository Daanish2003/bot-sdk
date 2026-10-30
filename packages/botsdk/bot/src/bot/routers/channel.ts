import { channelsContract } from "@botsdk/client/bot/contract";
import { implement } from "@orpc/server";

import type { Context } from "../../context";
import { requireAuth } from "../../procedures";
import { emailAddressOf, rotateEmailAddress, notificationRouteOf } from "../conversation";

const os = implement({ channels: channelsContract }).$context<Context>().use(requireAuth);

/**
 * The Channels' procedures: it implements `channelsContract`, the email Channel (spec #761) and the
 * messaging Channels' Channel accounts (spec #1044).
 */
export const channelRouter = os.channels.router({
  email: {
    address: os.channels.email.address.handler(async ({ context, input }) => {
      const address = await emailAddressOf(context.sdk, {
        userId: context.user.id,
        botId: input.botId,
        domain: context.sdk.channels.emailDomain(),
      });
      // Where a Message the Bot starts, not urgent, would go now.
      const route = await notificationRouteOf(context.sdk, context.sdk.db, {
        userId: context.user.id,
        owner: input,
        urgent: false,
      });
      const nextChannel = route === "email" ? ("email" as const) : ("web" as const);
      return { address, nextChannel };
    }),
    rotate: os.channels.email.rotate.handler(async ({ context, input }) => ({
      address: await rotateEmailAddress(context.sdk, {
        userId: context.user.id,
        botId: input.botId,
        domain: context.sdk.channels.emailDomain(),
      }),
    })),
  },
  accounts: {
    list: os.channels.accounts.list.handler(({ context, input }) =>
      context.sdk.channels.accounts.list({ ...input, userId: context.user.id }),
    ),
    save: os.channels.accounts.save.handler(({ context, input }) =>
      context.sdk.channels.accounts.save({ ...input, userId: context.user.id }),
    ),
    remove: os.channels.accounts.remove.handler(({ context, input }) =>
      context.sdk.channels.accounts.remove({ ...input, userId: context.user.id }),
    ),
  },
});
