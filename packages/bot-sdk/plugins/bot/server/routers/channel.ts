import { implement } from "@orpc/server";

import type { Context } from "../../../../core/server/context";
import { requireAuth } from "../../../../core/server/procedures";
import { channelsContract } from "../../shared/contract";
import { emailAddressOf, rotateEmailAddress, lastUsedChannel } from "../conversation";

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
      return { address, nextChannel: await lastUsedChannel(context.sdk.db, input) };
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
