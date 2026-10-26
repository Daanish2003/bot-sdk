import { z } from "zod";

import { protectedProcedure } from "../../../../core/server/procedures";
import { emailAddressOf, rotateEmailAddress, lastUsedChannel } from "../conversation";

const botInput = z.object({ botId: z.uuid() });

/** The email Channel's procedures: a Bot's address, to copy or rotate (spec #761). */
export const channelRouter = {
  email: {
    /**
     * The Bot's address, made on the first read, and the Channel its next Bot-initiated Message
     * goes by: the one the user last wrote from.
     */
    address: protectedProcedure.input(botInput).handler(async ({ context, input }) => {
      const address = await emailAddressOf(context.sdk, {
        userId: context.user.id,
        botId: input.botId,
        domain: context.sdk.channels.emailDomain(),
      });
      return { address, nextChannel: await lastUsedChannel(context.sdk.db, input) };
    }),

    /** Gives the Bot a new address; mail to the old one is dropped from now on. */
    rotate: protectedProcedure.input(botInput).handler(async ({ context, input }) => ({
      address: await rotateEmailAddress(context.sdk, {
        userId: context.user.id,
        botId: input.botId,
        domain: context.sdk.channels.emailDomain(),
      }),
    })),
  },
};

/** The `channel` plugin's routers, by key. */
export type ChannelRouter = { channel: typeof channelRouter };
