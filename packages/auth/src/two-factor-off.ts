import type { Database } from "@ai-chat/db";
import { twoFactor, user } from "@ai-chat/db/schema/auth";
import { and, eq } from "drizzle-orm";

/**
 * Turns off a user's two-factor sign-in by a direct write (spec #277), since Better Auth has no admin
 * endpoint for it: the TOTP row goes and the flag clears in one transaction. Returns the user's email,
 * or `null` when no user has two-factor sign-in on, in which case nothing changes.
 */
export async function turnOffTwoFactorRows(
  database: Database,
  userId: string,
): Promise<{ email: string } | null> {
  return database.transaction(async (tx) => {
    const [updated] = await tx
      .update(user)
      .set({ twoFactorEnabled: false })
      .where(and(eq(user.id, userId), eq(user.twoFactorEnabled, true)))
      .returning({ email: user.email });
    if (!updated) return null;
    await tx.delete(twoFactor).where(eq(twoFactor.userId, userId));
    return updated;
  });
}
