/** The pages: a new Conversation, a Project and its edit form, Keys & settings, and the public Shared link page. */
export const pagesMessages = {
  "pages.couldntStartConversation": "Couldn't start the Conversation",
  "pages.projectUnavailable": "This Project can't be opened.",
  "pages.project": "Project",
  "pages.edit": "Edit",
  "pages.newChatInProject": "New chat in this Project",
  "pages.noProjectConversations": "No Conversations in this Project yet",
  "pages.loadMore": "Load more",
  "pages.deleteProject": "Delete Project",
  "pages.deleteProjectTitle": "Delete this Project?",
  "pages.countUnavailable":
    "Couldn't count this Project's Conversations, so it can't be deleted right now.",
  "pages.countChecking": "Checking how many Conversations it holds…",
  "pages.deleteProjectBody": ({ conversations }: { conversations: string }) =>
    `This deletes the Project and its ${conversations}, with their Messages and Shared links. This can't be undone.`,
  "pages.conversationCount": ({ count }: { count: number }) =>
    count === 0 ? "no Conversations" : `${count} ${count === 1 ? "Conversation" : "Conversations"}`,
  "pages.projectDeleted": ({ conversations }: { conversations: string }) =>
    `Project deleted with ${conversations}`,
  "pages.deleting": "Deleting…",
  "pages.cancel": "Cancel",
  "pages.projectSaved": "Project saved",
  "pages.name": "Name",
  "pages.defaultModel": "Default Model",
  "pages.noDefaultModel": "No default Model",
  "pages.unavailableModel": ({ model }: { model: string }) => `${model} (unavailable)`,
  "pages.projectModelHelp":
    "New Conversations in this Project start on this Model. Replies already written keep theirs.",
  "pages.instructions": "Instructions",
  "pages.projectInstructionsPlaceholder":
    "For example: this is my thesis on coastal erosion; cite sources.",
  "pages.projectInstructionsHelp":
    "Sent with every reply here, after your own Instructions. Where they conflict, this Project's win. Shared links never show them.",
  "pages.characterCount": ({ count, max }: { count: string; max: string }) =>
    `${count} / ${max} characters`,
  "pages.saving": "Saving…",
  "pages.save": "Save",
  "pages.keysIntro":
    "Bring your own Provider credentials. Keys are encrypted on the server and never shown again; you only see the last characters.",
  "pages.providers": "Providers",
  "pages.tools": "Tools",
  "pages.toolsHelp":
    "Tool credentials for features beyond chat. Without a Tavily key, web search is off.",
  "pages.verified": "Verified",
  "pages.notVerified": "Not verified",
  "pages.unverified": "Saved, not verified",
  "pages.noCredentials": "No credentials",
  "pages.comingSoon": "Coming soon",
  "pages.chatgptConnect": "Connect ChatGPT",
  "pages.chatgptConnected": "Connected via ChatGPT",
  "pages.chatgptDisconnect": "Disconnect ChatGPT",
  "pages.chatgptReconnect": "Reconnect ChatGPT",
  "pages.chatgptNeedsReconnect": "Your ChatGPT link no longer works",
  "pages.chatgptKeyWins": "Your saved key is used even if ChatGPT is linked",
  "pages.add": "Add",
  "pages.replace": "Replace",
  "pages.delete": "Delete",
  "pages.credentialsChecked": "Credentials checked and saved",
  "pages.checkAndSave": "Check & save",
  "pages.checking": "Checking…",
  "pages.yourData": "Your data",
  "pages.yourDataHelp":
    "Download your Projects, Conversations, Messages, settings and Shared links as one JSON file. Keys are never included.",
  "pages.continueConversation": "Continue this Conversation",
  "pages.couldntContinue": "Couldn't continue the Conversation",
  "pages.sharedHeader": "ai-chat · shared Conversation",
  "pages.shared": "Shared",
  "pages.userLabel": "User",
  "pages.sharedFooter":
    "Read-only snapshot. Attachments show as file names only; their contents aren't shared.",
  "pages.sharedNotFoundTitle": "404: Shared link not found",
  "pages.sharedNotFoundBody": "This link doesn't exist, or its owner deleted it.",
};
