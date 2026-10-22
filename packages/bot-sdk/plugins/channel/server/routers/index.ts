import { z } from "zod";

import { protectedProcedure } from "../../../../core/server/procedures";
import { emailAddressOf, rotateEmailAddress } from "../address";

const botInput = z.object({ botId: z.uuid() });

/** The email Channel's procedures: a Bot's address, to copy or rotate (spec #761). */
export const channelRouter = {
  email: {
    /** The Bot's address, made on the first read. */
    address: protectedProcedure.input(botInput).handler(async ({ context, input }) => ({
      address: await emailAddressOf(context.sdk, {
        userId: context.user.id,
        botId: input.botId,
        domain: context.sdk.plugin("channel").emailDomain(),
      }),
    })),

    /** Gives the Bot a new address; mail to the old one is dropped from now on. */
    rotate: protectedProcedure.input(botInput).handler(async ({ context, input }) => ({
      address: await rotateEmailAddress(context.sdk, {
        userId: context.user.id,
        botId: input.botId,
        domain: context.sdk.plugin("channel").emailDomain(),
      }),
    })),
  },
};

/** The `channel` plugin's routers, by key. */
export type ChannelRouter = { channel: typeof channelRouter };
