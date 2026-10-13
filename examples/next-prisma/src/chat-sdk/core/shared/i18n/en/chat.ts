/** The chat view and composer: Messages and their actions, tool calls, searches, Attachments, usage, the Quota, the Web toggle, the welcome and no-credentials states, and the errors a reply shows. */
export const chatMessages = {
  "chat.decideFailed": ({ message }: { message: string }) => `Deciding failed: ${message}`,
  "chat.stopFailed": ({ message }: { message: string }) => `Stopping failed: ${message}`,
  "chat.toolSwitchFailed": ({ message }: { message: string }) =>
    `Switching a tool failed: ${message}`,
  "chat.branchSwitchFailed": ({ message }: { message: string }) =>
    `Switching Branch failed: ${message}`,
  "chat.tooManyMessages": "Too many messages. Try again in a moment.",
  "chat.approveFirst": "Approve or deny the tool call first",
  "chat.composerPlaceholder": "Message (Shift+Enter for a new line)",
  "chat.messageLabel": "Message",
  "chat.stop": "Stop",
  "chat.send": "Send",

  "chat.contextCut": "Earlier messages are no longer in the model's context",
  "chat.you": "You",
  "chat.assistant": "Assistant",
  "chat.tokenUsage": "Token usage",
  "chat.edit": "Edit",
  "chat.editNewBranch": "Edit (new Branch)",
  "chat.regenerate": "Regenerate",
  "chat.regenerateNewBranch": "Regenerate (new Branch)",
  "chat.thinking": "Thinking…",
  "chat.loading": "Loading",
  "chat.thoughtAFewSeconds": "Thought for a few seconds",
  "chat.previousBranch": "Previous Branch",
  "chat.nextBranch": "Next Branch",
  "chat.copy": "Copy",
  "chat.cancel": "Cancel",
  "chat.saveAndSubmit": "Save & submit",
  "chat.saveCreatesBranch":
    "Saving creates a new Branch. The old one stays reachable with the arrows.",
  "chat.editMessage": "Edit Message",
  "chat.stopped": "Stopped",
  "chat.keySettings": "Key settings",

  "chat.attachFiles": "Attach files",
  "chat.cantAttach": ({ name }: { name: string }) => `"${name}" can't be attached for this Model`,
  "chat.tooLarge": ({ name }: { name: string }) => `"${name}" is larger than 5 MB`,
  "chat.sizeBytes": ({ count }: { count: string }) => `${count} B`,
  "chat.sizeKilobytes": ({ count }: { count: string }) => `${count} KB`,
  "chat.sizeMegabytes": ({ count }: { count: string }) => `${count} MB`,
  "chat.kindImage": "Image",
  "chat.kindPdf": "PDF",
  "chat.kindText": "Text",
  "chat.removeFile": ({ name }: { name: string }) => `Remove ${name}`,

  "chat.contextSummary": ({
    tokens,
    window,
    percent,
  }: {
    tokens: string;
    window: string;
    percent: number;
  }) => `${tokens} of ${window} tokens (${percent}%)`,
  "chat.context": ({ summary }: { summary: string }) => `Context: ${summary}`,
  "chat.contextOverflow":
    "Earlier Messages will be dropped from the next reply: they don't fit this Model's window.",
  "chat.reasoningEffort": "Reasoning effort",
  "chat.usageInput": "Input",
  "chat.usageOutput": "Output",
  "chat.usageReasoning": "Reasoning",
  "chat.usageCached": "Cached",
  "chat.usageEstimate": "Estimate: the Provider reported no usage for this reply.",

  "chat.quotaUsed": "Quota used",
  "chat.quotaPercentUsed": ({ percent }: { percent: number }) => `${percent}% of your Quota used`,
  "chat.quotaSpent": ({ resetsAt }: { resetsAt: string }) =>
    `You've used your Quota. Host Models are off until ${resetsAt}.`,
  "chat.addYourOwnKey": "Add your own key",

  "chat.tools": "Tools",
  "chat.toolsWithCount": ({ count }: { count: number }) => `Tools (${count})`,
  "chat.mcpServers": "MCP servers",
  "chat.on": "On",
  "chat.off": "Off",
  "chat.web": "Web",
  "chat.webOff": "Web off",
  "chat.webNoTools": "This Model can't use tools, so it can't use the web",
  "chat.webOnSearch": "Web on: search and read pages",
  "chat.webOnNeedsTavilyKey":
    "Web on: reads pages you link. Search needs a Tavily key in Keys & settings",

  "chat.whatsOnYourMind": "What's on your mind?",
  "chat.suggestionCtes": "Explain recursive CTEs like I'm five",
  "chat.suggestionRegex": "Write a regex that matches ISO dates",
  "chat.suggestionCompose": "Review this Docker Compose file",

  "chat.noModelsBody": "This app has no Models for you to chat with.",
  "chat.bringYourOwnKey": "Bring your own key to start",
  "chat.bringYourOwnKeyBody":
    "Every reply runs on your own Provider credentials. Add a key for one of the Providers to start chatting.",
  "chat.addProviderCredentials": "Add Provider credentials",
  "chat.keysEncrypted": "Keys are encrypted on the server and never shown again.",

  "chat.pickAnotherModel": "Pick another Model",
  "chat.addKeyOrPickModel": ({ label }: { label: string }) =>
    `Add ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label} key or pick another Model`,

  "chat.errorInvalidKey": "The Provider rejected your API key.",
  "chat.errorRateLimited": "The Provider rate limited this request. Try again in a moment.",
  "chat.errorProvider": "The Provider returned an error.",
  "chat.errorProviderWith": ({ error }: { error: string }) =>
    `The Provider returned an error: ${error}`,
  "chat.errorTimedOut": "The reply took too long and timed out.",
  "chat.errorInterrupted": "The reply was interrupted by a server restart.",
  "chat.errorGeneric": "Something went wrong.",

  "chat.toolRunning": "Running",
  "chat.toolDone": "Done",
  "chat.toolFailed": "Failed",
  "chat.toolCancelled": "Cancelled",
  "chat.toolWaiting": "Waiting for approval",
  "chat.toolDenied": "Denied",
  "chat.toolWaitingFor": ({ name }: { name: string }) => `Waiting for approval to use ${name}`,
  "chat.toolUsed": ({ name }: { name: string }) => `Used ${name}`,
  "chat.approve": "Approve",
  "chat.allowForConversation": "Allow for this Conversation",
  "chat.deny": "Deny",
  "chat.arguments": "Arguments",
  "chat.result": "Result",

  "chat.searchingFor": ({ query }: { query: string }) => `Searching the web for "${query}"…`,
  "chat.searchCancelled": "Search cancelled",
  "chat.searchFailedKey": "Search failed: Tavily rejected your key.",
  "chat.searchFailedQuota": "Search failed: Tavily's monthly quota is used up.",
  "chat.searchFailed": "Search failed.",
  "chat.searchNoResults": ({ query }: { query: string }) => `No results for "${query}"`,
  "chat.searchedQuery": ({ query, count }: { query: string; count: number }) =>
    `Searched "${query}" · ${count} ${count === 1 ? "source" : "sources"}`,
  "chat.searchedTimes": ({ count, sources }: { count: number; sources: number }) =>
    `Searched ${count} times · ${sources === 0 ? "no sources" : `${sources} ${sources === 1 ? "source" : "sources"}`}`,

  // Why a tool call or a page read failed, as a reader sees it. The code is stored on the part; the
  // Model reads the English its tool returned instead.
  "chat.toolError.failed": ({ message }: { message: string }) => `The tool failed: ${message}`,
  "chat.toolError.limit": "This reply already used its tool calls",
  "chat.toolError.fetchLimit": "This reply already read its pages",
  "chat.pageError.timedOut": "The page took too long to load",
  "chat.pageError.tooLarge": ({ megabytes }: { megabytes: number }) =>
    `The page is larger than ${megabytes} MB`,
  "chat.pageError.unsupported": "Only HTML, plain text, Markdown and JSON pages can be read",
  "chat.pageError.blocked": "The address is not a public address",
  "chat.pageError.httpError": "The page couldn't be fetched",
  "chat.pageError.failed": "The page couldn't be fetched",
};
