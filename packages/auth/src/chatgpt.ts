import type { Database } from "@ai-chat/db";

import type { createAuth } from "./index";
import { type LinkedAccessToken, linkedAccessToken } from "./linked-token";

// What the Host's `linkedCredentials` hook needs from the user's linked ChatGPT plan (ADR 0023).
export type ChatgptAccessToken = LinkedAccessToken;

/** The user's ChatGPT access token, refreshed by Better Auth when it is near expiry. */
export function chatgptAccessToken(
  auth: Pick<ReturnType<typeof createAuth>, "api">,
  database: Database,
  userId: string,
): Promise<ChatgptAccessToken> {
  return linkedAccessToken(auth, database, userId, "chatgpt");
}
