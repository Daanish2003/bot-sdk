import { implement } from "@orpc/server";

import type { Context } from "../../../../core/server/context";
import { requireAuth } from "../../../../core/server/procedures";
import { botContract } from "../../shared/contract";
import { emailAddressOf, rotateEmailAddress, lastUsedChannel } from "../conversation";

const os = implement(botContract).$context<Context>().use(requireAuth);

/** The email Channel's procedures: it implements the contract's `channels` (spec #761). */
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
