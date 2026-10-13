import {
  type AnyTranscriptionAdapter,
  generateTranscription,
  type TranscriptionResult,
} from "@tanstack/ai";
import { createGrokTranscription, type GrokTranscriptionModel } from "@tanstack/ai-grok";
import { createGroqTranscription, type GroqTranscriptionModel } from "@tanstack/ai-groq";
import { createOpenaiTranscription, type OpenAITranscriptionModel } from "@tanstack/ai-openai";

import type { AppDeps, Credentials } from "../deps";
import { resolveCredentials } from "../credentials/resolve";
import type { DictationErrorReason } from "../../shared/chat/voice";
import { recordTranscriptionUsage } from "./host-usage";
import { quotaRefusal } from "./quota";

/** The transcription Models a user's own keys pick from, in order (spec #249). */
export const dictationEngines = [
  { provider: "openai", modelId: "gpt-4o-mini-transcribe" },
  { provider: "groq", modelId: "whisper-large-v3-turbo" },
  { provider: "grok", modelId: "grok-stt" },
] as const;

/** The Providers with a transcription adapter: the only ones a Host may list transcription Models for. */
export const transcriptionProviders: readonly string[] = dictationEngines.map(
  (engine) => engine.provider,
);

/** How long one Provider transcription may take before it is abandoned. */
export const transcriptionTimeoutMs = 2 * 60_000;

/** A dictation that failed, with the reason the composer tells the user. */
export class DictationError extends Error {
  readonly reason: DictationErrorReason;
  /** For `quota_exceeded`: when the Quota's window resets. */
  readonly resetsAt?: Date;

  constructor(
    reason: DictationErrorReason,
    message: string = `Dictation failed: ${reason}`,
    resetsAt?: Date,
  ) {
    super(message);
    this.name = "DictationError";
    this.reason = reason;
    this.resetsAt = resetsAt;
  }
}

/** The engine a dictation runs on: its `"provider:model"` id and the credentials it uses. */
type EngineCall = { provider: string; id: string; credentials: Credentials };

/**
 * The engine a dictation uses (spec #249): the user's own key first, then the Host's first
 * transcription Model (ADR 0007, amended for transcription). `onHost` says the Host pays, so the
 * call is checked against the Quota and metered at `pricePerMinuteUsd`. `null` when neither applies.
 */
export type DictationEngine =
  | (EngineCall & { onHost: false })
  | (EngineCall & { onHost: true; pricePerMinuteUsd: number });

/**
 * The first of the user's own Provider keys that transcribes, in `dictationEngines` order, with
 * its Model id (`"provider:model"`). `null` with `byok` off or with none of those keys. Own keys
 * are never metered.
 */
export async function ownDictationEngine(
  deps: Pick<AppDeps, "db" | "keyEncryptionSecrets" | "byok">,
  userId: string,
): Promise<EngineCall | null> {
  if (!deps.byok) return null;
  for (const engine of dictationEngines) {
    const credentials = await resolveCredentials(deps, userId, engine.provider);
    if (credentials) {
      return {
        provider: engine.provider,
        id: `${engine.provider}:${engine.modelId}`,
        credentials,
      };
    }
  }
  return null;
}

/**
 * The Host's first transcription Model: the first Provider entry that offers one, and its first
 * Model, with the Host's credentials. `null` when the Host offers none.
 */
export function hostDictationEngine(
  deps: Pick<AppDeps, "hostProviders">,
): (EngineCall & { pricePerMinuteUsd: number }) | null {
  for (const entry of deps.hostProviders) {
    const first = entry.transcriptionModels?.[0];
    if (first) {
      return {
        provider: entry.provider,
        id: `${entry.provider}:${first.model}`,
        credentials: entry.credentials,
        pricePerMinuteUsd: first.pricePerMinuteUsd,
      };
    }
  }
  return null;
}

/** The engine a dictation uses: the user's own key, else the Host's transcription Model (ADR 0007). */
export async function dictationEngine(
  deps: Pick<AppDeps, "db" | "keyEncryptionSecrets" | "byok" | "hostProviders">,
  userId: string,
): Promise<DictationEngine | null> {
  const own = await ownDictationEngine(deps, userId);
  if (own) return { ...own, onHost: false };
  const host = hostDictationEngine(deps);
  return host ? { ...host, onHost: true } : null;
}

/**
 * Transcribes one recording with the user's engine, through TanStack AI's `generateTranscription`.
 * The audio is passed on and never kept. On the Host's Model the Quota is checked first and the
 * call is metered after it succeeds (ADR 0007). A Provider failure becomes a `DictationError`.
 */
export async function transcribeRecording(
  deps: Pick<
    AppDeps,
    | "db"
    | "hooks"
    | "keyEncryptionSecrets"
    | "byok"
    | "hostProviders"
    | "getQuota"
    | "transcriptionAdapterFor"
  >,
  userId: string,
  {
    bytes,
    mimeType,
    durationSeconds,
    language,
  }: {
    bytes: Uint8Array<ArrayBuffer>;
    mimeType: string;
    durationSeconds: number;
    language?: string;
  },
): Promise<string> {
  const engine = await dictationEngine(deps, userId);
  if (!engine) {
    throw new DictationError("unavailable", "Dictation needs an OpenAI, Groq or Grok key of yours");
  }
  if (engine.onHost) {
    const refusal = await quotaRefusal(deps, userId);
    if (refusal) {
      throw new DictationError(
        "quota_exceeded",
        "You've used this window's Quota; try again after it resets",
        refusal.resetsAt,
      );
    }
  }
  const adapter = deps.transcriptionAdapterFor(engine.id, engine.credentials);
  let result: TranscriptionResult;
  try {
    result = await generateTranscription({
      adapter,
      audio: new Blob([bytes], { type: mimeType }),
      language,
      timeout: transcriptionTimeoutMs,
    });
  } catch (caught) {
    throw new DictationError(reasonOf(caught), "The transcription failed");
  }
  if (engine.onHost) {
    await recordTranscriptionUsage(
      deps,
      {
        userId,
        provider: engine.provider,
        model: engine.id,
        pricePerMinuteUsd: engine.pricePerMinuteUsd,
      },
      { durationSeconds, reportedSeconds: reportedSecondsOf(result) },
    );
  }
  return result.text;
}

/** The audio length the Provider reports: its `duration`, else the seconds it bills. */
function reportedSecondsOf(result: TranscriptionResult): number | undefined {
  if (result.duration !== undefined) return result.duration;
  const billed = result.usage?.billed;
  return billed?.unit === "seconds" ? billed.quantity : undefined;
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
