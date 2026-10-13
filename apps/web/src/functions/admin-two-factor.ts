import { turnOffTwoFactorRows } from "@ai-chat/auth/two-factor-off";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { log } from "evlog";

import { turnOffUserTwoFactor, twoFactorOffInput } from "@/admin/two-factor";
import { appName, sender } from "@/email";
import { adminMiddleware } from "@/middleware/admin";
import { auth, db } from "@/services";

/**
 * Turns off a user's lost two-factor sign-in (spec #277). Only after the request was confirmed by an
 * email reply (see `scripts/turn-off-2fa.md`). Admin only; the reason is required.
 */
export const turnOffTwoFactor = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator((input: unknown) => twoFactorOffInput.parse(input))
  .handler(async ({ data, context }) => {
    await turnOffUserTwoFactor(
      {
        disable: (userId) => turnOffTwoFactorRows(db, userId),
        revokeSessions: async (userId) => {
          await auth.api.revokeUserSessions({ body: { userId }, headers: getRequest().headers });
        },
        sender,
        appName,
        log,
      },
      { id: context.session?.user.id, role: context.session?.user.role },
      data,
    );
  });
