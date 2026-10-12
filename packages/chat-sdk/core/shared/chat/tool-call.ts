import type { MessagePart } from "@tanstack/ai";

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
  /** Set on a Shared link for a call whose arguments and result are kept private: only its name shows. */
  redacted: boolean;
};

/** The tool call a `useChat` part is, or `null` for any other part and for a `web_search` call. */
export function toolCallOf(part: MessagePart): ToolCallView | null {
  if (part.type !== "tool-call" || part.name === webSearchToolName) return null;
  const meta = (part.metadata ?? {}) as Partial<{
    source: string;
    status: ToolCallStatus;
    redacted: boolean;
  }>;
  return {
    id: part.id,
    name: part.name,
    // A call from the live stream carries no metadata; it is a Host call until it is stored.
    source: meta.source ?? "host",
    status: meta.status ?? statusOfState(part.state),
    args: part.input ?? safeParse(part.arguments),
    result: part.output,
    redacted: meta.redacted === true,
  };
}

/** The status of a live call, from the `useChat` state it streams in. */
function statusOfState(state: string): ToolCallStatus {
  if (state === "complete") return "done";
  if (state === "error") return "error";
  return "running";
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
