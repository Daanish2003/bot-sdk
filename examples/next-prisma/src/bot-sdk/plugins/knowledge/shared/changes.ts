/**
 * One file a Bot's Turn saved to Knowledge (spec #737), as the Turn's "saved to Knowledge" chip
 * lists it: the Bot that wrote it, and its path relative to the Knowledge folder.
 */
export type BotKnowledgeChange = { botId: string; path: string };
