type TitledConversation = {
  title: string | null;
  messages: Array<{ role: "user" | "assistant"; status: string }>;
};

/** How long the top bar keeps checking for an automatic title after a reply completes. */
export const titleWaitMs = 30_000;

/**
 * Whether the server is about to title the Conversation: it has no title yet, nothing is
 * streaming, and a reply completed (the server titles after a run ends `complete`).
 */
export function awaitingTitle(conversation: TitledConversation | undefined) {
  if (!conversation || conversation.title !== null) return false;
  const { messages } = conversation;
  return (
    !messages.some((m) => m.status === "streaming") &&
    messages.some((m) => m.role === "assistant" && m.status === "complete")
  );
}
