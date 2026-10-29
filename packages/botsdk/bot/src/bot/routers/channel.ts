import { channelsContract } from "@botsdk/client/bot/contract";
import { implement } from "@orpc/server";

import type { Context } from "../../context";
import { requireAuth } from "../../procedures";
import { emailAddressOf, rotateEmailAddress, lastUsedChannel } from "../conversation";
import { notificationSettingsOf } from "../notifications-api";

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
      // A non-urgent Message the Bot starts goes where the user chose, else where they last wrote.
      const { other } = await notificationSettingsOf(context.sdk.db, context.user.id);
      const nextChannel = other
        ? other === "email"
          ? ("email" as const)
          : ("web" as const)
        : await lastUsedChannel(context.sdk.db, input);
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
