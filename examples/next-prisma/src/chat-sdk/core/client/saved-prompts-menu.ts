/**
 * The composer's `/` menu for Saved prompts (#259). Browser-safe: the menu's rules live here, and
 * the popover only renders them.
 */
import {
  savedPromptLimit,
  savedPromptNameMessage,
  savedPromptNamePattern,
  savedPromptTextMaxChars,
} from "../shared/chat/saved-prompt";

/** The `/` query while the menu may open; undefined when the whole value isn't `/` plus a name. */
export function slashQuery(value: string): string | undefined {
  const match = /^\/(\S*)$/.exec(value);
  return match ? match[1] : undefined;
}

/**
 * The Saved prompts that match `query`: names starting with it first, then names containing it,
 * then prompts whose text contains it. An empty query keeps every prompt in the order given.
 */
export function rankSavedPrompts<T extends { name: string; text: string }>(
  prompts: T[],
  query: string,
): T[] {
  if (query === "") return prompts;
  const needle = query.toLowerCase();
  const tier = (prompt: T) => {
    const name = prompt.name.toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (prompt.text.toLowerCase().includes(needle)) return 2;
    return undefined;
  };
  return prompts
    .map((prompt) => ({ prompt, rank: tier(prompt) }))
    .filter((entry): entry is { prompt: T; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.prompt);
}

/** The first line of a Saved prompt's text, trimmed; what its row shows under the name. */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

/** The name the create row would save: the query itself when it is a valid name. */
export function createName(query: string): string | undefined {
  return savedPromptNamePattern.test(query) ? query : undefined;
}

/** Why a new or edited Saved prompt can't be saved, as the form shows it; undefined when it can. */
export function savedPromptDraftError(
  prompts: { name: string }[],
  draft: { name: string; text: string },
): string | undefined {
  if (!savedPromptNamePattern.test(draft.name)) return savedPromptNameMessage;
  if (prompts.some((prompt) => prompt.name === draft.name)) {
    return `You already have a Saved prompt named "${draft.name}"`;
  }
  if (draft.text.trim() === "") return "Text can't be blank";
  if (draft.text.length > savedPromptTextMaxChars) {
    return `Text is limited to ${savedPromptTextMaxChars.toLocaleString("en-US")} characters`;
  }
  if (prompts.length >= savedPromptLimit) {
    return `You have ${savedPromptLimit} Saved prompts. Delete one first.`;
  }
  return undefined;
}
