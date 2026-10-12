import { z } from "zod";

/**
 * The stored shape of a Message's `parts` (ADR 0001): our own zod union, versioned, never
 * TanStack AI's `UIMessage` parts. core/shared/chat/parts converts it.
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

export const searchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  publishedDate: z.string().optional(),
});

/** One `web_search` tool call of a reply and how it went. Failures are states, never a Message error. */
export const webSearchPartSchema = z.object({
  type: z.literal("web_search"),
  toolCallId: z.string(),
  query: z.string(),
  state: z.enum(["running", "done", "error", "cancelled"]),
  results: z.array(searchResultSchema).max(5),
  errorReason: z.enum(["invalid_key", "quota_exhausted", "failed"]).optional(),
});

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
  state: z.enum(["running", "done", "error", "cancelled", "awaiting_approval", "denied"]),
});

export const storedPartSchema = z.discriminatedUnion("type", [
  textPartSchema,
  thinkingPartSchema,
  webSearchPartSchema,
  toolCallPartSchema,
]);

/**
 * The schema version a Message's parts are written at. 2 added `tool_call` (ADR 0008); a version 1
 * row has no `tool_call` part, so it still reads.
 */
export const storedPartsSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  parts: z.array(storedPartSchema),
});

export type StoredPart = z.infer<typeof storedPartSchema>;
export type WebSearchPart = z.infer<typeof webSearchPartSchema>;
export type ToolCallPart = z.infer<typeof toolCallPartSchema>;
export type StoredParts = z.infer<typeof storedPartsSchema>;

export function storedParts(parts: StoredPart[]): StoredParts {
  return { schemaVersion: 2, parts };
}
