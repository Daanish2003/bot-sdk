// What the Keys page needs to link and unlink a Connection (ADR 0037). It is apart from
// `connections.ts`, whose Host tools must not reach the browser.

// The Better Auth provider behind each Connection, by the Connection's key. These are
// `GITHUB_CONNECTION_PROVIDER`, `GOOGLE_CALENDAR_PROVIDER` and `GMAIL_PROVIDER` of @ai-chat/auth,
// written out here so the Keys page doesn't pull the auth server into the browser.
export const connectionProviders: Record<string, string> = {
  github: "github-connection",
  google_calendar: "google-calendar",
  gmail: "gmail",
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
