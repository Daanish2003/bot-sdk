/** A Saved prompt's name: lowercase letters, digits and `-`, 1 to 32 characters (`/name`). */
export const savedPromptNamePattern = /^[a-z0-9-]{1,32}$/;

export const savedPromptNameMessage =
  "Names use lowercase letters, digits and -, up to 32 characters";

/** The most characters a Saved prompt's text may hold, counted as typed. */
export const savedPromptTextMaxChars = 10_000;

/** How many Saved prompts one user may keep. */
export const savedPromptLimit = 100;
