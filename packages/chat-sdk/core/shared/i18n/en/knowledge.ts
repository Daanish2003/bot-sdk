/** The Project's Knowledge tab: the Model picker, the upload, the files table and its states. */
export const knowledgeMessages = {
  "knowledge.tabConversations": "Conversations",
  "knowledge.tabKnowledge": "Knowledge",
  "knowledge.model": "Embedding Model",
  "knowledge.modelHelp":
    "Reads this Project's files so the assistant can search them. It's fixed once the Project has a file.",
  "knowledge.lockedModel": ({ model, source }: { model: string; source: string }) =>
    `${model} (${source})`,
  "knowledge.sourceOwn": "your key",
  "knowledge.sourceHost": "Host",
  "knowledge.noModel": "No embedding Model available",
  "knowledge.addKey": "Uploads need an OpenAI or Gemini key. Add a key",
  "knowledge.keyMissing": ({ provider }: { provider: string }) =>
    `Search unavailable: add your ${provider} key`,
  "knowledge.upload": "Upload files",
  "knowledge.uploading": "Uploading…",
  "knowledge.uploadStarted": ({ name }: { name: string }) => `${name} is being read`,
  "knowledge.name": "Name",
  "knowledge.details": "Details",
  "knowledge.status": "Status",
  "knowledge.typeMarkdown": "Markdown",
  "knowledge.typeText": "Text",
  "knowledge.typeHtml": "HTML",
  "knowledge.typeCsv": "CSV",
  "knowledge.typeWord": "Word",
  "knowledge.typePdf": "PDF",
  "knowledge.passages": ({ count }: { count: number }) =>
    count === 1 ? "1 passage" : `${count} passages`,
  "knowledge.addedOn": ({ date }: { date: string }) => `Added ${date}`,
  "knowledge.processing": "Processing",
  "knowledge.ready": "Ready",
  "knowledge.failed": "Failed",
  "knowledge.failure.no_text": "No text found in this file",
  "knowledge.failure.unreadable": "Couldn't read this file",
  "knowledge.failure.encrypted": "This file is encrypted or password-protected",
  "knowledge.failure.too_large": "Too large or complex to process",
  "knowledge.failure.no_credentials": "No credentials for the Model",
  "knowledge.failure.failed": "Couldn't process this file",
  "knowledge.actions": "Actions",
  "knowledge.retry": "Retry",
  "knowledge.delete": "Delete",
  "knowledge.deleteConfirm": ({ name }: { name: string }) =>
    `Delete "${name}"? Its passages are removed too, and the assistant stops using it.`,
  "knowledge.emptyTitle": "No Knowledge files yet",
  "knowledge.emptyHelp": ({ size, types }: { size: number; types: string }) =>
    `Add ${types} files up to ${size} MB each. The assistant searches them when a question needs them.`,
};
