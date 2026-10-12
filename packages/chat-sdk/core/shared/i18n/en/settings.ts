/** The Keys & settings sections that aren't credentials: Connections, Instructions, Shared links, Titles and deleting Conversations. */
export const settingsMessages = {
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
  "settings.titleModel": "Title Model",
  "settings.sameAsFirstReply": "Same as first reply",
  "settings.noKeyModel": ({ model }: { model: string }) => `${model} (no key)`,
  "settings.titleMissingKey": ({ reason }: { reason: string }) =>
    `${reason}. Until then, titles are the start of your first Message.`,
  "settings.titleHelp":
    "Writes each new Conversation's title after the first reply. A cheap Model is enough.",
};
