/** Unlinks every ChatGPT account row of the user, one after another, and no other account. */
export async function unlinkChatgpt(
  accounts: { id: string; providerId: string }[],
  unlink: (accountId: string) => Promise<void>,
): Promise<void> {
  for (const linked of accounts.filter((account) => account.providerId === "chatgpt")) {
    await unlink(linked.id);
  }
}
