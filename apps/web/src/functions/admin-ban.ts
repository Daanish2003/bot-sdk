import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { log } from "evlog";
import { z } from "zod";

import { banEndsAt, isCalendarDate } from "@/admin/ban";
import { adminMiddleware } from "@/middleware/admin";
import { auth, db, sdk } from "@/services";

const reason = z.string().trim().min(1, "Give a reason").max(500);

const banInput = z.object({
  userId: z.string().min(1),
  reason,
  /** The last day the Ban covers (`YYYY-MM-DD`, UTC), or `null` for a Ban until it is lifted. */
  endsOn: z.string().refine(isCalendarDate, "Pick a real date").nullable().default(null),
});

const unbanInput = z.object({
  userId: z.string().min(1),
  reason: reason.nullable().default(null),
});

/**
 * Bans a user (spec #277): the plugin's ban deletes their sessions and blocks every sign-in method;
 * their live Runs stop through the Stop path. An Admin can't be banned, nor can the Admin themselves.
 * Writes one evlog event for the action.
 */
export const banUser = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator((input: unknown) => banInput.parse(input))
  .handler(async ({ data, context }) => {
    const target = await db.query.user.findFirst({
      where: { id: data.userId },
      columns: { role: true },
    });
    if (!target) throw new Error("No user has that id");
    if (target.role === "admin") throw new Error("An Admin can't be banned");

    const endsAt = banEndsAt(data.endsOn);
    const secondsLeft = endsAt ? Math.ceil((endsAt.getTime() - Date.now()) / 1000) : null;
    if (secondsLeft !== null && (!Number.isFinite(secondsLeft) || secondsLeft <= 0)) {
      throw new Error("The end date must be in the future");
    }

    await auth.api.banUser({
      body: {
        userId: data.userId,
        banReason: data.reason,
        ...(secondsLeft !== null && { banExpiresIn: secondsLeft }),
      },
      headers: getRequest().headers,
    });
    // Logged as soon as the Ban holds, so it's recorded even if stopping the Runs throws.
    log.info({
      action: "admin.user.ban",
      message: "User banned by an Admin",
      actor: context.session?.user.id,
      target: data.userId,
      reason: data.reason,
      endsAt: endsAt?.toISOString() ?? null,
    });
    await sdk.admin.stopRuns(data.userId);

    return { endsAt: endsAt?.toISOString() ?? null };
  });

/** Lifts a user's Ban (spec #277), with one evlog event. Their sessions were already ended by the Ban. */
export const unbanUser = createServerFn({ method: "POST" })
  .middleware([adminMiddleware])
  .inputValidator((input: unknown) => unbanInput.parse(input))
  .handler(async ({ data, context }) => {
    await auth.api.unbanUser({
      body: { userId: data.userId },
      headers: getRequest().headers,
    });

    log.info({
      action: "admin.user.unban",
      message: "User unbanned by an Admin",
      actor: context.session?.user.id,
      target: data.userId,
      reason: data.reason,
    });
  });
