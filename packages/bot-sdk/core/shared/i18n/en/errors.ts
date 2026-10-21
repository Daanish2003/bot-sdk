/**
 * The errors the server sends as a code and params (spec #256). A key is a code the server puts in
 * `data.code`; the client shows its text, with numbers already formatted in the locale.
 */
export const errorMessages = {
  "error.unexpected": "Something went wrong. Try again.",
  "error.unauthorized": "Sign in to continue.",
  "error.conversationNotFound": "Conversation not found",
  "error.messageNotFound": "Message not found",
  "error.projectNotFound": "Project not found",
  "error.botNotFound": "Bot not found",
  "error.secretTooShort": ({ min }: { min: number }) =>
    `That value is too short to keep out of output: use at least ${min} characters.`,
  "error.routineNotFound": "Routine not found",
  "error.routineNotWebhook": "Only an approved webhook Routine has a URL to rotate",
  "error.checkInNotFound": "Check-in not found",
  "error.helperNotFound": "Helper not found",
  "error.reviewNotFound": "Request not found",
  "error.helperStopped": "This task was stopped.",
  "error.demonstrationNotFound": "Demonstration not found",
  "error.demonstrationEnded": "This Demonstration has ended.",
  "error.messageIdTaken": "That message id is already used",
  "error.sharedLinkNotFound": "Shared link not found",
  "error.invalidCursor": "Invalid cursor",
  "error.modelNotAvailable": ({ model }: { model: string }) =>
    `"${model}" is not an available Model`,
  "error.imageModelNotAvailable": ({ model }: { model: string }) =>
    `"${model}" is not an available Image Model`,
  "error.unknownMcpServer": "Unknown MCP server",
  "error.pickAnotherModel": "Pick another Model",
  "error.addKey": ({ label }: { label: string }) =>
    `Add ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label} key or pick another Model`,
  "error.instructionsTooLong": ({ max }: { max: string }) =>
    `Instructions are limited to ${max} characters`,
  "error.projectLimit": ({ max }: { max: string }) => `You can have at most ${max} Projects`,
  "error.pinLimit": ({ max }: { max: string }) =>
    `You can pin up to ${max} Conversations. Unpin one first.`,
  "error.byokOff": "Your own keys are turned off on this app",
  "error.memoryTextBlank": "A Memory can't be blank",
  "error.memoryLineChanged": "That line changed since you opened it. Reload and try again.",
  "error.memoryLogMonth": "A Log file needs a month, YYYY-MM",
  "error.memoryNeedsComputer": "Bot memory needs a Computer",
  "error.memoryComputerUnavailable": "Your Computer can't be reached right now",
  "error.skillsNeedComputer": "Skills need a Computer",
  "error.skillsComputerUnavailable": "Your Computer can't be reached right now",
  "error.skillNotFound": "Skill not found",
  "error.skillName":
    "A Skill's name is lowercase letters, digits and hyphens, at most 64 characters",
  "error.attachmentTooLarge": ({ name }: { name: string }) => `"${name}" is larger than 5 MB`,
  "error.attachmentNotSupported": ({ name }: { name: string }) =>
    `"${name}" can't be attached: only images, PDFs and text files can`,
  "error.attachmentNotUtf8": ({ name }: { name: string }) => `"${name}" isn't a UTF-8 text file`,
  "error.knowledgeNoModel": "Uploads need an OpenAI or Gemini key. Add a key",
  "error.knowledgeFileLimit": ({ max }: { max: number }) =>
    `A Project can hold at most ${max} Knowledge files`,
  "error.knowledgeFileTooLarge": ({ name, max }: { name: string; max: number }) =>
    `"${name}" is larger than ${max} MB`,
  "error.knowledgeFileNotSupported": ({ name, types }: { name: string; types: string }) =>
    `"${name}" can't be a Knowledge file: only ${types} files can`,
  "error.knowledgeFileNotUtf8": ({ name }: { name: string }) => `"${name}" isn't a UTF-8 text file`,
  "error.knowledgeModelNotAvailable": ({ model }: { model: string }) =>
    `"${model}" is not an available embedding Model`,
  "error.knowledgeModelLocked": "The embedding Model is fixed once the Project has Knowledge files",
  "error.knowledgeFileNotFound": "Knowledge file not found",
  "error.knowledgeFileNotFailed": "Only a Knowledge file that failed can be retried",
  "error.decisionNotWaiting": "The Message is not waiting for Approval",
  "error.replyStreaming": "A reply is still streaming in this Conversation",
  "error.modelCannotResume":
    "The Model can't resume this reply: its Model or credentials are unavailable",
  "error.quotaSpent": "You've used this window's Quota",
  "error.invalidCommand": "Invalid chat command",
  "error.regenerateAttachments": "A regenerate can't add attachments; edit the Message instead",
  "error.parentNotFound": "The parent Message is not in this Conversation",
  "error.regenerateNeedsMessage": "Only a reply to your Message can be regenerated",
  "error.approveFirst": "Approve or deny the tool call first",
  "error.messageTooLong":
    "This message is too long for the Model's context window. Shorten it or remove an attachment.",
  "error.attachmentNotFound": "Attachment not found",
  "error.modelCantRead": ({ model, kind }: { model: string; kind: "text" | "image" | "pdf" }) =>
    `${model} can't read ${kind === "pdf" ? "PDFs" : kind === "image" ? "images" : "text files"}`,
  "error.branchAttachmentsTooLarge": "Attachments on this Branch would pass 20 MB",
  "error.tooManyMessages": "Too many messages. Try again in a moment.",
  "error.tooManyRequests": "Too many requests; try again in a moment",
  "error.shuttingDown": "The chat is shutting down; try again shortly",
  "error.invalidRunId": "Invalid Run id",
  "error.runNotFound": "Run not found",
  "error.shareEmpty": "There's nothing to share yet",
  "error.shareStreaming": "Wait for the reply to finish before sharing",
  "error.shareErrored": "The newest reply ended in an error",
  "error.noModelToContinue": "No Model is available to continue this Conversation",
  "error.keyRejected": ({ label }: { label: string }) => `${label} rejected this API key.`,
  "error.keyCheckFailed": ({ label, status }: { label: string; status: string }) =>
    `Couldn't check the key with ${label} (HTTP ${status}). Try again.`,
  "error.keyUnreachable": ({ label }: { label: string }) =>
    `Couldn't reach ${label} to check the key. Try again.`,
  "error.ollamaUnreachable": ({ host }: { host: string }) =>
    `Couldn't reach Ollama at ${host}. Under Docker, use http://host.docker.internal:11434.`,
  "error.temporaryPin": "A Temporary Conversation can't be pinned",
  "error.temporaryInProject": "A Temporary Conversation can't be in a Project",
  "error.temporaryMove": "A Temporary Conversation can't be moved into a Project",
  "error.temporaryShare": "A Temporary Conversation can't be shared",
  "error.rateNotAssistant": "Only an assistant Message can be rated",
  "error.rateLive": "The reply can be rated once its Run has ended",
  "error.rateHidden": "A hidden reply can't be rated",
  "error.savedPromptName": "Names use lowercase letters, digits and -, up to 32 characters",
  "error.savedPromptTextBlank": "Text can't be blank",
  "error.savedPromptTextTooLong": ({ max }: { max: string }) =>
    `Text is limited to ${max} characters`,
  "error.savedPromptNameTaken": ({ name }: { name: string }) =>
    `You already have a Saved prompt named "${name}"`,
  "error.savedPromptLimit": ({ max }: { max: string }) =>
    `You have ${max} Saved prompts. Delete one first.`,
  "error.savedPromptNotFound": "Saved prompt not found",
  "error.recordingTooLong": "A recording can be at most 10 minutes",
  "error.recordingType": "That recording isn't an audio type dictation accepts",
  "error.recordingTooLarge": "A recording can be at most 25 MB",
  "error.dictationFailed": "The transcription failed",
  "error.artifactVersionNotFound": "Artifact version not found",
};
