/** The Keys & settings sections that aren't credentials: Memory, Connections, the Image Model and Export data. */
export const settingsMessages = {
  "settings.exportFailed": "Couldn't export your data",
  "settings.preparing": "Preparing…",
  "settings.exportData": "Export my data",
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
  "settings.hostDefaultModel": ({ model }: { model: string }) => `Host default (${model})`,
  "settings.noKeyModel": ({ model }: { model: string }) => `${model} (no key)`,
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
