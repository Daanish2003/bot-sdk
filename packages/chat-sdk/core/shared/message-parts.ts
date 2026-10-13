import { z } from "zod";

import { artifactKinds } from "./chat/artifact";
import { maxExcerptsPerSearch } from "./chat/knowledge-search";

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

/**
 * Why a tool failed, as a dictionary code and its params (spec #256): the client shows the text for
 * the code in the reader's language. The text the Model reads for the same failure stays English.
 */
export const toolErrorSchema = z.object({
  code: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export type ToolError = z.infer<typeof toolErrorSchema>;

/**
 * One `web_search` tool call of a reply and how it went. Failures are states, never a Message error.
 * `error` is the failure's code; `errorReason` is what a part stored before codes, still read.
 */
export const webSearchPartSchema = z.object({
  type: z.literal("web_search"),
  toolCallId: z.string(),
  query: z.string(),
  state: z.enum(["running", "done", "error", "cancelled"]),
  results: z.array(searchResultSchema).max(5),
  errorReason: z.enum(["invalid_key", "quota_exhausted", "quota_exceeded", "failed"]).optional(),
  error: toolErrorSchema.optional(),
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
  /** A failed call's code (spec #256). `result` keeps the English text the Model read. */
  error: toolErrorSchema.optional(),
  state: z.enum(["running", "done", "error", "cancelled", "awaiting_approval", "denied"]),
});

/** Why a Generated image failed (spec #278). Each one is a state, never a Message error. */
export const generatedImageErrorReasons = [
  "refused",
  "quota_exceeded",
  "limit_reached",
  "too_many_images",
  "failed",
] as const;

/**
 * One `generate_image` tool call of a reply and how it went (spec #278), shaped like a search. The
 * image itself is the `generated_image` row its `imageId` names. `prompt` is what the Model asked
 * for, and `aspectRatio` the shape it asked for. `editedFrom` holds the ids of the images (Generated
 * images or image Attachments) an edit started from.
 */
export const generatedImagePartSchema = z.object({
  type: z.literal("generated_image"),
  toolCallId: z.string(),
  prompt: z.string(),
  aspectRatio: z.enum(["square", "landscape", "portrait"]),
  state: z.enum(["running", "done", "error", "cancelled"]),
  imageId: z.string().optional(),
  errorReason: z.enum(generatedImageErrorReasons).optional(),
  editedFrom: z.array(z.string()).optional(),
});

/**
 * A version of an Artifact the reply created (spec #304). Slim: the content is never in the
 * Message's parts; the panel reads it from the version's row on demand.
 */
export const artifactPartSchema = z.object({
  type: z.literal("artifact"),
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string(),
  kind: z.enum(artifactKinds),
  state: z.literal("done"),
});

/**
 * One `search_knowledge` call of a reply (spec #357, ticket #206): the query and the passages it
 * found, snapshotted so the reply keeps them after their file is deleted. `error` is the failure's
 * code; a failed search has no passages.
 */
export const knowledgeSearchPartSchema = z.object({
  type: z.literal("knowledge_search"),
  toolCallId: z.string(),
  query: z.string(),
  state: z.enum(["running", "done", "error", "cancelled"]),
  excerpts: z
    .array(
      z.object({
        fileId: z.string(),
        fileName: z.string(),
        chunkIndex: z.number().int().nonnegative(),
        text: z.string(),
      }),
    )
    .max(maxExcerptsPerSearch),
  error: toolErrorSchema.optional(),
});

export const storedPartSchema = z.discriminatedUnion("type", [
  textPartSchema,
  thinkingPartSchema,
  webSearchPartSchema,
  toolCallPartSchema,
  generatedImagePartSchema,
  artifactPartSchema,
  knowledgeSearchPartSchema,
]);

/**
 * The schema version a Message's parts are written at. 2 added `tool_call` (ADR 0008); a version 1
 * row has no `tool_call` part, so it still reads. 3 added `generated_image` and `artifact`; versions
 * 1 and 2 still read. 4 added `knowledge_search`.
 */
export const storedPartsSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  parts: z.array(storedPartSchema),
});

export type StoredPart = z.infer<typeof storedPartSchema>;
export type WebSearchPart = z.infer<typeof webSearchPartSchema>;
export type ToolCallPart = z.infer<typeof toolCallPartSchema>;
export type GeneratedImagePart = z.infer<typeof generatedImagePartSchema>;
export type ArtifactPart = z.infer<typeof artifactPartSchema>;
export type KnowledgeSearchPart = z.infer<typeof knowledgeSearchPartSchema>;
export type StoredParts = z.infer<typeof storedPartsSchema>;

export function storedParts(parts: StoredPart[]): StoredParts {
  return { schemaVersion: 4, parts };
}
