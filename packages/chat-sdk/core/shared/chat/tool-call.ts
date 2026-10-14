import { type MessagePart, parsePartialJSON } from "@tanstack/ai";

import { generateImageToolName } from "./generated-image";
import { searchKnowledgeToolName } from "./knowledge-search";
import type { ToolError } from "../message-parts";
import { searchPastChatsToolName } from "./past-chats";
import { webSearchToolName } from "./web-search";

/**
 * A tool call other than `web_search` (a Host tool, later an MCP tool), as the chat shows it. It
 * is the generic `tool_call` part (ADR 0008): the one row renders every such call. No server code,
 * so the browser and the Shared link redaction both read it.
 */

/** `awaiting_approval` until the user decides; `denied` when they refused the call (ADR 0008). */
export type ToolCallStatus =
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "awaiting_approval"
  | "denied";

export type ToolCallView = {
  id: string;
  name: string;
  source: string;
  status: ToolCallStatus;
  args: unknown;
  result: unknown;
  /** Why a failed call failed, as a dictionary code (spec #256); the reader's text replaces its result. */
  error?: ToolError;
  /** Set on a Shared link for a call whose arguments and result are kept private: only its name shows. */
  redacted: boolean;
};

/**
 * The tool call a `useChat` part is, or `null` for any other part, a `web_search`, `generate_image`,
 * `search_past_chats` or `search_knowledge` call (each has its own row).
 */
export function toolCallOf(part: MessagePart): ToolCallView | null {
  if (part.type !== "tool-call") return null;
  if (
    part.name === webSearchToolName ||
    part.name === generateImageToolName ||
    part.name === searchPastChatsToolName ||
    part.name === searchKnowledgeToolName
  ) {
    return null;
  }
  const meta = (part.metadata ?? {}) as Partial<{
    source: string;
    status: ToolCallStatus;
    redacted: boolean;
    error: ToolError;
  }>;
  return {
    id: part.id,
    name: part.name,
    // A call from the live stream carries no metadata; it is a Host call until it is stored.
    source: meta.source ?? "host",
    status: meta.status ?? statusOfState(part.state),
    // A call still streaming has only its partial arguments; the partial parse reads them as they come.
    args: part.input ?? parsePartialJSON(part.arguments),
    result: part.output,
    ...(meta.error && { error: meta.error }),
    redacted: meta.redacted === true,
  };
}

/** The status of a live call, from the `useChat` state it streams in. */
function statusOfState(state: string): ToolCallStatus {
  if (state === "complete") return "done";
  if (state === "error") return "error";
  return "running";
}
