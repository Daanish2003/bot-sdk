import { channelsContract } from "@botsdk/client/bot/contract";
import { implement } from "@orpc/server";

import type { Context } from "../../context";
import { requireAuth } from "../../procedures";
import { emailAddressOf, rotateEmailAddress, notificationRouteOf } from "../conversation";

const os = implement({ channels: channelsContract }).$context<Context>().use(requireAuth);

/** The email Channel's procedures: it implements `channelsContract` (spec #761). */
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
});
