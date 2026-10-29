/** The Keys & settings sections that aren't credentials: Memory, Connections, the Image Model, Notifications and Export data. */
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
  // Custom Rules (spec #989).
  "settings.rulesTitle": "Rules",
  "settings.rulesIntro":
    "Tell your Bots what is fine to do without asking, what to ask about first, and what you want to do yourself. Rules apply to all your Bots.",
  "settings.rulesCount": ({ count, max }: { count: number; max: number }) =>
    `${count} of ${max} rules`,
  "settings.rulesEmpty": "No rules yet.",
  "settings.rulesLimit": ({ max }: { max: number }) =>
    `You have ${max} rules, the most allowed. Delete one to add another.`,
  "settings.rulesFootnote":
    "Rules reach only the calls Auto-review checks, such as shell commands and browser or desktop actions. A rule about reading a file does nothing.",
  "settings.neverAllowedTitle": "Never allowed",
  "settings.neverAllowedIntro":
    "Your Bots never do these, whatever your rules or Approvals say. They tell you to do it yourself. You can't change this list.",
  "settings.rulesProposedTitle": "Proposed by your Bots",
  "settings.addRule": "Add a rule",
  "settings.saveRule": "Save rule",
  "settings.ruleText": "Rule",
  "settings.ruleTextPlaceholder": "Reply to emails from anyone @acme.com",
  "settings.ruleMode": "What happens",
  "settings.ruleModeWithoutAsking": "Without asking",
  "settings.ruleModePreApproved": "If pre-approved",
  "settings.ruleModeAsk": "Ask before",
  "settings.ruleModeHandOff": "Hand off to me",
  "settings.deleteRule": "Delete rule",
  // Notification settings (spec #1024).
  "settings.notifications": "Notifications",
  "settings.notificationsHelp":
    "For messages your Bots send on their own, from a Routine, a Check-in, a Helper or a webhook. Replies to your messages go back where you wrote from. These apply to all your Bots.",
  "settings.quietHours": "Quiet hours",
  "settings.quietHoursHelp":
    "In your time zone. During them, only urgent messages are emailed or pushed. The rest are still in the conversation for when you look.",
  "settings.quietFrom": "From",
  "settings.quietTo": "To",
  "settings.urgentRoute": "Urgent messages",
  "settings.otherRoute": "Other messages",
  "settings.routeDefault": "Where I last wrote",
  "settings.routeInApp": "In-app only",
  "settings.routeEmail": "Email",
  "settings.routePush": "Web push",
  "settings.routeHelp": "Every message is in the app, whatever you choose.",
  "settings.saveNotifications": "Save notifications",
  "settings.notificationsSaved": "Notifications saved",
  "settings.notificationsLoadFailed":
    "Couldn't load your notification settings. Reload to try again.",
  "settings.pushDevice": "Web push on this device",
  "settings.pushDeviceHelp":
    "Each device gets pushes once it is turned on there. With no choice for urgent messages, they are pushed to your devices.",
  "settings.pushEnable": "Enable push on this device",
  "settings.pushEnabled": "Push is on for this device.",
  "settings.pushDisable": "Turn off push on this device",
  "settings.pushUnsupported": "This browser can't show push notifications.",
  "settings.pushNeedsHomeScreen":
    "On iPhone and iPad, push needs iOS 16.4 or later and this app on your Home Screen: tap Share, then Add to Home Screen, and open it from there.",
  "settings.pushDenied":
    "Notifications are blocked for this site. Allow them in your browser's settings, then try again.",
  "settings.pushFailed": "Couldn't change push on this device",
  "settings.pushSaveFailed":
    "Couldn't save this device for push. Turn push off and on again to retry.",
};
