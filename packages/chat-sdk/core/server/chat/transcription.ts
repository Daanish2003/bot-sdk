import { type AnyTranscriptionAdapter, generateTranscription } from "@tanstack/ai";
import { createGrokTranscription, type GrokTranscriptionModel } from "@tanstack/ai-grok";
import { createGroqTranscription, type GroqTranscriptionModel } from "@tanstack/ai-groq";
import { createOpenaiTranscription, type OpenAITranscriptionModel } from "@tanstack/ai-openai";

import type { AppDeps, Credentials } from "../deps";
import { resolveCredentials } from "../credentials/resolve";
import type { DictationErrorReason } from "../../shared/chat/voice";

/** The transcription Models a user's own keys pick from, in order (spec #249). */
export const dictationEngines = [
  { provider: "openai", modelId: "gpt-4o-mini-transcribe" },
  { provider: "groq", modelId: "whisper-large-v3-turbo" },
  { provider: "grok", modelId: "grok-stt" },
] as const;

/** How long one Provider transcription may take before it is abandoned. */
export const transcriptionTimeoutMs = 2 * 60_000;

/** A dictation that failed, with the reason the composer tells the user. */
export class DictationError extends Error {
  readonly reason: DictationErrorReason;

  constructor(reason: DictationErrorReason, message: string = `Dictation failed: ${reason}`) {
    super(message);
    this.name = "DictationError";
    this.reason = reason;
  }
}

/**
 * The first of the user's own Provider keys that transcribes, in `dictationEngines` order, with
 * its Model id (`"provider:model"`). `null` with `byok` off or with none of those keys. Own keys
 * are never metered.
 */
export async function ownDictationEngine(
  deps: Pick<AppDeps, "db" | "keyEncryptionSecrets" | "byok">,
  userId: string,
): Promise<{ id: string; credentials: Credentials } | null> {
  if (!deps.byok) return null;
  for (const engine of dictationEngines) {
    const credentials = await resolveCredentials(deps, userId, engine.provider);
    if (credentials) {
      return { id: `${engine.provider}:${engine.modelId}`, credentials };
    }
  }
  return null;
}

/**
 * Transcribes one recording with the user's engine, through TanStack AI's `generateTranscription`.
 * The audio is passed on and never kept. A Provider failure becomes a `DictationError`.
 */
export async function transcribeRecording(
  deps: Pick<AppDeps, "db" | "keyEncryptionSecrets" | "byok" | "transcriptionAdapterFor">,
  userId: string,
  {
    bytes,
    mimeType,
    language,
  }: { bytes: Uint8Array<ArrayBuffer>; mimeType: string; language?: string },
): Promise<string> {
  const engine = await ownDictationEngine(deps, userId);
  if (!engine) {
    throw new DictationError("unavailable", "Dictation needs an OpenAI, Groq or Grok key of yours");
  }
  const adapter = deps.transcriptionAdapterFor(engine.id, engine.credentials);
  try {
    const result = await generateTranscription({
      adapter,
      audio: new Blob([bytes], { type: mimeType }),
      language,
      timeout: transcriptionTimeoutMs,
    });
    return result.text;
  } catch (caught) {
    throw new DictationError(reasonOf(caught), "The transcription failed");
  }
}

/**
 * The production `deps.transcriptionAdapterFor`: the TanStack AI transcription adapter for a
 * `"provider:model"` id, built from the user's key for that Provider.
 */
export function transcriptionAdapterFor(
  id: string,
  credentials: Credentials,
): AnyTranscriptionAdapter {
  const separator = id.indexOf(":");
  const provider = id.slice(0, separator);
  const model = id.slice(separator + 1);
  const apiKey = credentials.apiKey;
  if (!apiKey) throw new Error(`The ${provider} credentials have no API key`);

  switch (provider) {
    case "openai":
      return createOpenaiTranscription(model as OpenAITranscriptionModel, apiKey);
    case "groq":
      return createGroqTranscription(model as GroqTranscriptionModel, apiKey);
    case "grok":
      return createGrokTranscription(model as GrokTranscriptionModel, apiKey);
    default:
      throw new Error(`No transcription adapter is available for the ${provider} Provider`);
  }
}

/** A Provider error as a dictation reason: a refused key, a Provider rate limit, or any other failure. */
function reasonOf(caught: unknown): DictationErrorReason {
  const { code, status } = (typeof caught === "object" && caught !== null ? caught : {}) as {
    code?: unknown;
    status?: unknown;
  };
  if (status === 401 || status === 403 || code === "invalid_api_key") return "invalid_key";
  if (status === 429 || code === "rate_limit_exceeded") return "rate_limited";
  return "failed";
}
