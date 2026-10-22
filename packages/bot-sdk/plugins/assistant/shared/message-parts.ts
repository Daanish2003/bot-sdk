import { z } from "zod";

import {
  textPartSchema,
  thinkingPartSchema,
  toolCallPartSchema,
  toolErrorSchema,
} from "../../../core/shared/message-parts";
import { artifactKinds } from "./chat/artifact";

export {
  textPartSchema,
  thinkingPartSchema,
  toolCallPartSchema,
  toolErrorSchema,
  toolSourceSchema,
  type ToolCallPart,
  type ToolError,
} from "../../../core/shared/message-parts";

/**
 * The assistant's stored shape of a Message's `parts` (ADR 0001): the core's envelope with our own
 * zod union over the core's base parts, versioned, never TanStack AI's `UIMessage` parts. ./chat/parts
 * converts it.
 */

export const searchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  publishedDate: z.string().optional(),
});

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

/** One past Conversation a `search_past_chats` call found, with the snippets it matched (spec #263). */
export const pastChatSchema = z.object({
  conversationId: z.string(),
  title: z.string(),
  /** The date of the Message the first snippet comes from, as an ISO string. */
  date: z.string(),
  snippets: z.array(z.string()).max(3),
});

/**
 * One `search_past_chats` call of a reply and how it went (spec #263). `conversations` are the
 * Conversations it found, at most 5; a failed search is a state, never a Message error.
 */
export const pastChatsSearchPartSchema = z.object({
  type: z.literal("past_chats_search"),
  toolCallId: z.string(),
  query: z.string(),
  state: z.enum(["running", "done", "error", "cancelled"]),
  conversations: z.array(pastChatSchema).max(5),
});

export const storedPartSchema = z.discriminatedUnion("type", [
  textPartSchema,
  thinkingPartSchema,
  webSearchPartSchema,
  toolCallPartSchema,
  generatedImagePartSchema,
  artifactPartSchema,
  pastChatsSearchPartSchema,
]);

/**
 * The schema version a Message's parts are written at. 2 added `tool_call` (ADR 0008); a version 1
 * row has no `tool_call` part, so it still reads. 3 added `generated_image` and `artifact`; versions
 * 1 and 2 still read. 4 added `knowledge_search` (removed with the old Knowledge, spec #737); 5
 * added `past_chats_search`; earlier versions still read.
 */
export const storedPartsSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  parts: z.array(storedPartSchema),
  /** The IANA time zone a Bot user's Message was sent from, when the client sent one. */
  timeZone: z.string().optional(),
  /** The Channel besides web a Bot thread Message came in on (a user's) or also went out on (a Bot's), spec #761. */
  channel: z.literal("email").optional(),
  /** An emailed Bot user's Message's subject, which the Bot's emailed reply answers (spec #761). */
  subject: z.string().optional(),
});

export type StoredPart = z.infer<typeof storedPartSchema>;
export type WebSearchPart = z.infer<typeof webSearchPartSchema>;
export type GeneratedImagePart = z.infer<typeof generatedImagePartSchema>;
export type ArtifactPart = z.infer<typeof artifactPartSchema>;
export type PastChatsSearchPart = z.infer<typeof pastChatsSearchPartSchema>;
export type StoredParts = z.infer<typeof storedPartsSchema>;

export function storedParts(parts: StoredPart[]): StoredParts {
  return { schemaVersion: 5, parts };
}
