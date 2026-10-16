import { z } from "zod";

/**
 * The core's part of a Message's stored `parts` (ADR 0001, ADR 0020): the envelope, the base parts
 * (`text`, `thinking`, `tool_call`) and the plain text that search reads. A plugin composes its
 * own parts union over the base parts and owns the `schemaVersion`.
 */

export const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

/**
 * A model's thinking. `signature` is the Provider's opaque reasoning artefact, sent back only to
 * the same Provider; a `redacted` block (Anthropic `redacted_thinking`) has no text, only that.
 */
export const thinkingPartSchema = z.object({
  type: z.literal("thinking"),
  text: z.string(),
  signature: z.string().optional(),
  redacted: z.boolean().optional(),
});

/**
 * Why a tool failed, as a dictionary code and its params (spec #256): the client shows the text for
 * the code in the reader's language. The text the Model reads for the same failure stays English.
 */
export const toolErrorSchema = z.object({
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export type ToolError = z.infer<typeof toolErrorSchema>;

/** Where a tool came from: the SDK (`web_search` has its own part), the Host, or an MCP server. */
export const toolSourceSchema = z.enum(["builtin", "host", "mcp"]);

/**
 * One tool call of a reply other than `web_search` (ADR 0008): a Host tool or, later, an MCP tool.
 * `args` and `result` are what the tool was called with and returned, as JSON. A failed call has a
 * `result` of `{ error }`; a call cut off before it finished stays without one. A call that needs
 * Approval is `awaiting_approval` until the user decides: `denied` when refused, else it runs.
 */
export const toolCallPartSchema = z.object({
  type: z.literal("tool_call"),
  toolCallId: z.string(),
  name: z.string(),
  source: toolSourceSchema,
  args: z.unknown(),
  result: z.unknown().optional(),
  /** A failed call's code (spec #256). `result` keeps the English text the Model read. */
  error: toolErrorSchema.optional(),
  state: z.enum(["running", "done", "error", "cancelled", "awaiting_approval", "denied"]),
});

export type TextPart = z.infer<typeof textPartSchema>;
export type ThinkingPart = z.infer<typeof thinkingPartSchema>;
export type ToolCallPart = z.infer<typeof toolCallPartSchema>;
/** The parts every plugin's union has. */
export type BasePart = TextPart | ThinkingPart | ToolCallPart;

/**
 * The stored shape of a Message's `parts` as the core sees it: a versioned list whose parts it
 * knows only by `type`, so the core never imports a plugin's parts.
 */
export type PartsEnvelope = { schemaVersion: number; parts: { type: string }[] };

/** The plain text `message.searchText` holds: the text parts only. */
export function searchTextOf(envelope: {
  parts: readonly { type: string; text?: string }[];
}): string {
  return envelope.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
