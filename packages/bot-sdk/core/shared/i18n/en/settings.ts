/** The Keys & settings sections that aren't credentials: Connections, Instructions, Shared links, Titles and deleting Conversations. */
export const settingsMessages = {
  "settings.memory": "Memory",
  "settings.memoryHelp":
    "What your Bots remember about you, kept as files on your Computer. Each Bot's page shows its memory.",
  "settings.memoryUse": "Use and make Memories",
  "settings.memoryOffBanner":
    "Memory is off. Your Bots' memory files are kept, but Bots neither read nor write them.",
  "settings.connected": "Connected",
  "settings.reconnectNeeded": "Reconnect needed",
  "settings.notConnected": "Not connected",
  "settings.connections": "Connections",
  "settings.connectionsHelp": "Servers your app offers. Signing in connects your account to them.",
  "settings.scopes": ({ scopes }: { scopes: string }) => ` · Scopes: ${scopes}`,
  "settings.reconnect": "Reconnect",
  "settings.connect": "Connect",
  "settings.disconnect": "Disconnect",
  "settings.deleteAllDone": "All Conversations deleted",
  "settings.deleteAllTitle": "Delete all Conversations",
  "settings.deleteAllHelp":
    "Removes every Conversation, including those in your Projects, and their Shared links. Your Projects stay, empty. Your account stays too.",
  "settings.deleteAllConfirmTitle": "Delete all Conversations?",
  "settings.deleteAllConfirmBody":
    "This deletes every Conversation for good, with its Messages and Shared links. Your Projects stay, but they are left empty. This can't be undone.",
  "settings.typeToConfirmBefore": "Type",
  "settings.typeToConfirmAfter": "to confirm",
  "settings.deleteAll": "Delete all",
  "settings.deleting": "Deleting…",
  "settings.cancel": "Cancel",
  "settings.exportFailed": "Couldn't export your data",
  "settings.preparing": "Preparing…",
  "settings.exportData": "Export my data",
  "settings.instructionsSaved": "Instructions saved",
  "settings.instructions": "Instructions",
  "settings.yourInstructions": "Your Instructions",
  "settings.instructionsPlaceholder":
    "For example: answer briefly, use British spelling, I write TypeScript.",
  "settings.characterCount": ({ count, max }: { count: string; max: string }) =>
    `${count} / ${max} characters`,
  "settings.saving": "Saving…",
  "settings.save": "Save",
  "settings.instructionsHelp":
    "Sent with every Run from the next one, after the chat's own rules. Shared links never show them.",
  "settings.sharedLinks": "Shared links",
  "settings.sharedLinksHelp":
    "Anyone with a link can read its Conversation. Revoking a link stops its URL working at once.",
  "settings.sharedLinksLoadFailed": ({ message }: { message: string }) =>
    `Couldn't load your Shared links: ${message}`,
  "settings.noSharedLinks": "You haven't shared any Conversations.",
  "settings.sharedAgo": ({ time }: { time: string }) => `Shared ${time}`,
  "settings.revoke": "Revoke",
  "settings.copyFailed": "Couldn't copy the link",
  "settings.copied": "Copied",
  "settings.copyLink": "Copy link",
  "settings.titles": "Titles",
  "settings.backgroundModel": "Background Model",
  "settings.sameAsFirstReply": "Same as first reply",
  "settings.hostDefaultModel": ({ model }: { model: string }) => `Host default (${model})`,
  "settings.noKeyModel": ({ model }: { model: string }) => `${model} (no key)`,
  "settings.titleMissingKey": ({ reason }: { reason: string }) =>
    `${reason}. Until then, titles are the start of your first Message.`,
  "settings.backgroundModelHelp": "Used for titles and Memory; pick a cheap, fast Model.",
  "settings.backgroundModelHostDefaultHelp":
    "Used for titles and Memory; pick a cheap, fast Model. Nothing picked uses the Host's default.",
  "settings.archivedConversations": "Archived Conversations",
  "settings.archivedHelp":
    "Archived Conversations leave the sidebar but stay in search and open by their link. Sending them a Message brings them back.",
  "settings.archivedLoadFailed": ({ message }: { message: string }) =>
    `Couldn't load your archived Conversations: ${message}`,
  "settings.noArchived": "You haven't archived any Conversations.",
  "settings.lastMessage": ({ time }: { time: string }) => `Last message ${time}`,
  "settings.open": "Open",
  "settings.unarchive": "Unarchive",
  "settings.archivedCount": ({ count }: { count: number }) =>
    count === 1 ? "Archived 1 Conversation" : `Archived ${count} Conversations`,
  "settings.archiveAll": "Archive all",
  "settings.archiveAllConfirmTitle": "Archive all Conversations?",
  "settings.archiveAllConfirmBody":
    "This archives every Conversation outside your Projects that isn't pinned. Pinned Conversations and those in Projects stay where they are. You can unarchive any of them from this list.",
  "settings.archiving": "Archiving…",
  "settings.savedPrompts": "Saved prompts",
  "settings.newSavedPrompt": "New Saved prompt",
  "settings.savedPromptsHelp":
    "Text you send often. Insert one into the composer by typing its /name, then edit it before sending. Nothing is sent by itself.",
  "settings.savedPromptsLoadFailed": ({ message }: { message: string }) =>
    `Couldn't load your Saved prompts: ${message}`,
  "settings.noSavedPrompts": "You haven't saved any Saved prompts yet.",
  "settings.savePrompt": "Save prompt",
  "settings.saveChanges": "Save changes",
  "settings.edit": "Edit",
  "settings.savedPromptDeleted": "Saved prompt deleted",
  "settings.savedPromptSaved": "Saved prompt saved",
  "settings.savedPromptName": "Name",
  "settings.savedPromptNamePlaceholder": "review",
  "settings.savedPromptText": "Text",
  "settings.savedPromptTextPlaceholder": "Review this code for bugs first, then suggest fixes.",
  // Image Model (spec #278).
  "settings.images": "Images",
  "settings.imageModel": "Image Model",
  "settings.noImages": "No images",
  "settings.imageModelMissingKey":
    "This Image Model's key was removed, so no images are made until you pick another.",
  "settings.imageModelHelp":
    "Makes images when you ask for one. Images on the Host's credentials count against your allowance.",
  "settings.onHost": "· Host",
};
