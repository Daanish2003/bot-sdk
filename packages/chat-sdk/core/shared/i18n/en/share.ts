/** The Shared link dialog: creating, updating, previewing and deleting a Conversation's link, and why sharing is blocked. */
export const shareMessages = {
  "share.title": ({ title }: { title: string }) => `Share "${title}"`,
  "share.description":
    "Anyone with the link sees this Branch up to its newest Message, read-only and without your name. Thinking is hidden, and attachments show as file names only: their contents are never shared.",
  "share.loadFailed": ({ message }: { message: string }) =>
    `Couldn't load the Shared link: ${message}`,
  "share.blockedEmpty": "Send a message before sharing.",
  "share.blockedStreaming": "Wait for the reply to finish before sharing.",
  "share.blockedError": "The newest reply ended in an error. Regenerate it before sharing.",
  "share.sharedAgo": ({ time }: { time: string }) => `Shared ${time}.`,
  "share.movedOn": "The Conversation has moved on since; Update link to share the current Branch.",
  "share.deleteLink": "Delete link",
  "share.preview": "Preview",
  "share.updateLink": "Update link",
  "share.createLink": "Create link",
  "share.copyLink": "Copy link",
  "share.copied": "Copied",
  "share.copyFailed": "Couldn't copy the link",
};
