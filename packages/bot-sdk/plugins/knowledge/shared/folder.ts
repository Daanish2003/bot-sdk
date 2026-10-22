/** A user's Knowledge folder on their Computer, shared by all of their Bots (ADR 0025). */
export const knowledgeDirectory = "/home/user/shared/knowledge";

/** The most all of a user's Knowledge may hold, in bytes, checked at upload. */
export const knowledgeLimitBytes = 50 * 1024 * 1024;

/** The formats a user can add as they are. */
export const knowledgeExtensions = [".md", ".txt", ".html", ".csv"] as const;
