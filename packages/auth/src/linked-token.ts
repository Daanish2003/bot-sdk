import type { Database } from "@ai-chat/db";
import { account } from "@ai-chat/db/schema/auth";
import { and, desc, eq } from "drizzle-orm";
import { isAPIError } from "better-auth/api";

import type { createAuth } from "./index";

// What a Host hook needs from a user's link-only Better Auth account: the linked ChatGPT plan
// (ADR 0023) or a Connection (ADR 0037).
export type LinkedAccessToken =
  | { status: "ok"; accessToken: string; expiresAt?: Date }
  // The user has not linked the provider.
  | { status: "none" }
  // The link exists but its token can't be refreshed (revoked or rejected): the user must link again.
  | { status: "needs-reconnect" };

/**
 * The user's access token for a link-only provider, refreshed by Better Auth when it is within five
 * seconds of expiry. Better Auth looks an account up by its row id, not by provider, so the row is
 * found first (the newest, if the user linked more than one).
 */
export async function linkedAccessToken(
  auth: Pick<ReturnType<typeof createAuth>, "api">,
  database: Database,
  userId: string,
  providerId: string,
): Promise<LinkedAccessToken> {
  const [linked] = await database
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, providerId)))
    .orderBy(desc(account.createdAt))
    .limit(1);
  if (!linked) return { status: "none" };
  try {
    const { accessToken, accessTokenExpiresAt } = await auth.api.getAccessToken({
      body: { accountId: linked.id, userId },
    });
    return { status: "ok", accessToken, expiresAt: accessTokenExpiresAt };
  } catch (error) {
    // Better Auth answers every refresh failure with this one code. Anything else (a broken
    // database, say) is not the user's to fix by linking again.
    if (isAPIError(error) && error.body?.code === "FAILED_TO_GET_ACCESS_TOKEN") {
      return { status: "needs-reconnect" };
    }
    throw error;
  }
}
