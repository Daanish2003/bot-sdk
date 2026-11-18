// What the Keys page needs to link and unlink a Connection (ADR 0037). It is apart from
// `connections.ts`, whose Host tools must not reach the browser.

import {
  GITHUB_CONNECTION_PROVIDER,
  GMAIL_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER,
} from "@ai-chat/auth/providers";

// The Better Auth provider behind each Connection, by the Connection's key. From the auth
// package's browser-safe module, so the Keys page doesn't pull the auth server into the browser.
export const connectionProviders: Record<string, string> = {
  github: GITHUB_CONNECTION_PROVIDER,
  google_calendar: GOOGLE_CALENDAR_PROVIDER,
  gmail: GMAIL_PROVIDER,
};

/** Unlinks every account row of a Connection, one after another, and no other account. */
export async function unlinkConnection(
  accounts: { id: string; providerId: string }[],
  key: string,
  unlink: (accountId: string) => Promise<void>,
): Promise<void> {
  const providerId = connectionProviders[key];
  if (!providerId) return;
  for (const linked of accounts.filter((account) => account.providerId === providerId)) {
    await unlink(linked.id);
  }
}
