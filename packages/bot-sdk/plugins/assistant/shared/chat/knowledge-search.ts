import type { MessagePart } from "@tanstack/ai";

import type { KnowledgeSearchPart, ToolError } from "../message-parts";

/**
 * The `search_knowledge` tool's contract (spec #357, ticket #206), shared by the server tool, the
 * parts boundary and the web app. No server code: safe to import into the browser.
 */

export const searchKnowledgeToolName = "search_knowledge";

/** Passages one search returns to the Model, the best first. */
export const maxExcerptsPerSearch = 8;

/** What the Model reads when a search can't run or fails; the reply goes on without it. */
export const knowledgeUnavailableError = "Knowledge unavailable";

/** The dictionary code a failed search is stored under (spec #256). */
export const knowledgeErrorCodes = {
  failed: "chat.knowledgeFailed",
  quota_exceeded: "chat.knowledgeNotRunQuota",
} as const;

/** A passage as the Model reads it: its label (`excerpt:<n>`), its file's name and its text. */
export type Excerpt = { id: string; fileName: string; text: string };

/** The `search_knowledge` tool result the Model sees: the passages found, or why none were. */
export type KnowledgeSearchOutput = { excerpts: Excerpt[] } | { error: string };

/**
 * The passages of a finished search, labelled from the reply's next label. `offset` is the number
 * of Excerpts the reply already has, so each label is unique within its Message (spec #357).
 */
export function knowledgeOutput(
  excerpts: { fileName: string; text: string }[],
  offset = 0,
): KnowledgeSearchOutput {
  return {
    excerpts: excerpts.map(({ fileName, text }, index) => ({
      id: `excerpt:${offset + index + 1}`,
      fileName,
      text,
    })),
  };
}

/** The result a stored search part gives: its passages, or the unavailable error when it failed. */
export function knowledgeOutputOf(
  part: Pick<KnowledgeSearchPart, "state" | "excerpts">,
  offset = 0,
): KnowledgeSearchOutput {
  if (part.state === "error") return { error: knowledgeUnavailableError };
  return knowledgeOutput(part.excerpts, offset);
}

/** The line that tells the Model which Knowledge files it can search, and how to cite a passage. */
export function knowledgePromptOf(fileNames: string[]): string {
  return (
    "This Project has these Knowledge files, which you can search with search_knowledge when a " +
    `question may be answered from them: ${fileNames.join(", ")}. When you use a passage ` +
    "search_knowledge returned, cite it right after the claim with a markdown link whose text is " +
    "the passage's file name and whose url is its id, for example: The budget is 5,000 " +
    "([brief.md](excerpt:2)). Only cite ids that a search returned. Don't add numbered markers " +
    "like [1]; the app numbers the citations."
  );
}

/** The state of a live call, from the `useChat` state it streams in: a stream error cancels it. */
function liveStateOf(state: string): KnowledgeSearchView["state"] {
  if (state === "complete") return "done";
  return state === "error" ? "cancelled" : "running";
}

/** A search as the chat shows it. The passage texts are absent on a Shared link. */
export type KnowledgeSearchView = {
  toolCallId: string;
  query: string;
  state: "running" | "done" | "error" | "cancelled";
  /** `label` is the id the reply cites the passage by (`excerpt:<n>`). */
  excerpts: { label?: string; fileName: string; text?: string }[];
  error?: ToolError;
};

/**
 * The search a `useChat` part shows, whether it streamed in or came from `toUIParts`; `null` for
 * any other part and for a call whose query hasn't streamed in yet.
 */
export function knowledgeSearchOf(part: MessagePart): KnowledgeSearchView | null {
  if (part.type !== "tool-call" || part.name !== searchKnowledgeToolName) return null;
  const output = part.output as
    | { excerpts?: { id?: unknown; fileName?: unknown; text?: unknown }[]; error?: unknown }
    | null
    | undefined;
  const meta = (part.metadata ?? {}) as Partial<{
    status: KnowledgeSearchView["state"];
    error: ToolError;
  }>;
  const input = (part.input ?? {}) as { query?: unknown };
  const query = typeof input.query === "string" ? input.query : "";
  if (!query && !output) return null;

  const excerpts = Array.isArray(output?.excerpts)
    ? output.excerpts.map((excerpt) => ({
        ...(typeof excerpt.id === "string" && { label: excerpt.id }),
        fileName: String(excerpt.fileName ?? ""),
        ...(typeof excerpt.text === "string" && { text: excerpt.text }),
      }))
    : [];
  const failed = typeof output?.error === "string";
  const state: KnowledgeSearchView["state"] =
    failed || meta.status === "error" ? "error" : (meta.status ?? liveStateOf(part.state));
  return {
    toolCallId: part.id,
    query,
    state,
    excerpts,
    ...(meta.error && { error: meta.error }),
  };
}
