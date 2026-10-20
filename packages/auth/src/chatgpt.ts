import type { Database } from "@ai-chat/db";
import { account } from "@ai-chat/db/schema/auth";
import { and, eq } from "drizzle-orm";

import type { createAuth } from "./index";

// What the Host's `linkedCredentials` hook needs from the user's linked ChatGPT plan (ADR 0023).
export type ChatgptAccessToken =
  | { status: "ok"; accessToken: string }
  // The user has not linked ChatGPT.
  | { status: "none" }
  // The link exists but its token can't be refreshed (revoked or rejected): the user must link again.
  | { status: "needs-reconnect" };

/**
 * The user's ChatGPT access token, refreshed by Better Auth when it is within five seconds of expiry.
 * Better Auth looks an account up by its row id, not by provider, so the row is found first.
 */
export async function chatgptAccessToken(
  auth: Pick<ReturnType<typeof createAuth>, "api">,
  database: Database,
  userId: string,
): Promise<ChatgptAccessToken> {
  const [linked] = await database
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "chatgpt")))
    .limit(1);
  if (!linked) return { status: "none" };
  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: { accountId: linked.id, userId },
    });
    return { status: "ok", accessToken };
  } catch {
    return { status: "needs-reconnect" };
  }
}
