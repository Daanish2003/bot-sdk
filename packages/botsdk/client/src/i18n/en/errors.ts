/**
 * The errors the server sends as a code and params (spec #256). A key is a code the server puts in
 * `data.code`; the client shows its text, with numbers already formatted in the locale.
 */
export const errorMessages = {
  "error.unexpected": "Something went wrong. Try again.",
  "error.unauthorized": "Sign in to continue.",
  "error.conversationNotFound": "Conversation not found",
  "error.messageNotFound": "Message not found",
  "error.botNotFound": "Bot not found",
  "error.botPaused": "Bot is paused. Resume to send.",
  "error.botPausedApproval": "Bot is paused. Resume to approve.",
  "error.botResetName": "Type the Bot's name to reset it.",
  "error.secretTooShort": ({ min }: { min: number }) =>
    `That value is too short to keep out of output: use at least ${min} characters.`,
  "error.customRuleNotFound": "Rule not found",
  "error.channelPlatformNotFound": "This messaging Channel isn't offered here.",
  "error.channelCredentialsRejected":
    "The platform rejected these credentials. Check them and try again.",
  "error.notificationRouteNotLinked": "Link your account on that Channel to send Messages there.",
  "error.channelAccountTaken": "That bot is already connected to someone else's Bot.",
  "error.customRuleLimit": ({ max }: { max: number }) =>
    `You can have at most ${max} active rules. Delete one to add another.`,
  "error.routineNotFound": "Routine not found",
  "error.routineNotWebhook": "Only an approved webhook Routine has a URL to rotate",
  "error.routineWebhookSchedule": "A webhook Routine has no schedule to edit",
  "error.checkInNotFound": "Check-in not found",
  "error.checkInNotPending": "This Check-in already fired or ended, so it can't be edited.",
  "error.checkInTooSoon": "Pick a time at least a minute from now.",
  "error.triggerNotFound": "Task not found",
  "error.triggerNotSkippable": "Only a Routine run or a Check-in can be skipped",
  "error.triggerTaken": "The Bot already started this one.",
  "error.helperNotFound": "Helper not found",
  "error.reviewNotFound": "Request not found",
  "error.helperStopped": "This task was stopped.",
  "error.choiceAnswered": "This question was already answered.",
  "error.choiceInvalid": "That is not one of the options.",
  "error.demonstrationNotFound": "Demonstration not found",
  "error.demonstrationEnded": "This Demonstration has ended.",
  "error.messageIdTaken": "That message id is already used",
  "error.modelNotAvailable": ({ model }: { model: string }) =>
    `"${model}" is not an available Model`,
  "error.imageModelNotAvailable": ({ model }: { model: string }) =>
    `"${model}" is not an available Image Model`,
  "error.byokOff": "Your own keys are turned off on this app",
  "error.memoryTextBlank": "A Memory can't be blank",
  "error.memoryLineChanged": "That line changed since you opened it. Reload and try again.",
  "error.memoryLogMonth": "A Log file needs a month, YYYY-MM",
  "error.memoryNeedsComputer": "Bot memory needs a Computer",
  "error.memoryComputerUnavailable": "Your Computer can't be reached right now",
  "error.skillsNeedComputer": "Skills need a Computer",
  "error.skillsComputerUnavailable": "Your Computer can't be reached right now",
  "error.skillExists": "A Skill with that name already exists",
  "error.skillNotFound": "Skill not found",
  "error.skillName":
    "A Skill's name is lowercase letters, digits and hyphens, at most 64 characters",
  "error.knowledgeNeedsComputer": "Knowledge needs a Computer",
  "error.knowledgeComputerUnavailable": "Your Computer can't be reached right now",
  "error.knowledgeFormat": ({ name, types }: { name: string; types: string }) =>
    `"${name}" can't be added: Knowledge takes ${types} files`,
  "error.knowledgePath": "That isn't a name or folder Knowledge can use",
  "error.knowledgeFull": "Knowledge is full: it holds at most 50 MB",
  "error.knowledgeExists": ({ path }: { path: string }) => `"${path}" is already in Knowledge`,
  "error.knowledgeNoSuchFile": "That file isn't in Knowledge",
  "error.knowledgeNoText": "This PDF has no text to read (it may be a scan)",
  "error.knowledgeNoDocText": "This document has no text to read",
  "error.knowledgeEncrypted": ({ name }: { name: string }) => `"${name}" is password-protected`,
  "error.knowledgeTooComplex": ({ name }: { name: string }) =>
    `"${name}" is too large or complex to read`,
  "error.knowledgeUnreadable": ({ name }: { name: string }) => `"${name}" can't be read`,
  "error.knowledgeDocumentTooLarge": ({ name }: { name: string }) =>
    `"${name}" is larger than 20 MB`,
  "error.knowledgeTextTooLong": ({ name }: { name: string }) =>
    `"${name}" has more than 2 MB of text. Split it into smaller files`,
  "error.knowledgeNotUtf8": ({ name }: { name: string }) => `"${name}" isn't a UTF-8 text file`,
  "error.quotaSpent": "You've used this window's Quota",
  "error.botFileTooLarge": ({ name, max }: { name: string; max: number }) =>
    `"${name}" is larger than ${max} MB`,
  "error.botFilesTooMany": ({ max }: { max: number }) => `A message can carry at most ${max} files`,
  "error.botFileNotFound": "A file to send is no longer uploaded: attach it again",
  "error.tooManyRequests": "Too many requests; try again in a moment",
  "error.keyRejected": ({ label }: { label: string }) => `${label} rejected this API key.`,
  "error.keyCheckFailed": ({ label, status }: { label: string; status: string }) =>
    `Couldn't check the key with ${label} (HTTP ${status}). Try again.`,
  "error.keyUnreachable": ({ label }: { label: string }) =>
    `Couldn't reach ${label} to check the key. Try again.`,
  "error.ollamaUnreachable": ({ host }: { host: string }) =>
    `Couldn't reach Ollama at ${host}. Under Docker, use http://host.docker.internal:11434.`,
};
