import {
  type AnyTranscriptionAdapter,
  generateTranscription,
  type TranscriptionResult,
} from "@tanstack/ai";
import { createGrokTranscription, type GrokTranscriptionModel } from "@tanstack/ai-grok";
import { createGroqTranscription, type GroqTranscriptionModel } from "@tanstack/ai-groq";
import { createOpenaiTranscription, type OpenAITranscriptionModel } from "@tanstack/ai-openai";

import type { ModelsDeps, Credentials } from "./types";
import { type ResolveDeps, resolvePayer } from "./credentials/resolve";
import type { DictationErrorReason } from "../../../core/shared/chat/voice";
import { freeMeter, hostTranscriptionMeter, type TranscriptionMeter } from "./meter";

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

/**
 * The engine a dictation runs on (spec #249): its Provider, its `"provider:model"` id, the
 * credentials it uses, and its meter, which checks the Quota and prices the call when the Host pays.
 */
export type DictationEngine = {
  provider: string;
  id: string;
  credentials: Credentials;
  meter: TranscriptionMeter;
};

/**
 * The Host's first transcription Model: the first Provider entry that offers one, and its first
 * Model, with the Host's credentials. `undefined` when the Host offers none.
 */
function hostTranscriptionOffer(deps: Pick<ModelsDeps, "hostProviders">) {
  for (const entry of deps.hostProviders) {
    const first = entry.transcriptionModels?.[0];
    if (first) return { entry, first };
  }
  return undefined;
}

/**
 * The engine a dictation uses (`resolvePayer`, ADR 0007 amended for transcription): the first of
 * the user's own Provider keys that transcribes, in `dictationEngines` order, else the Host's first
 * transcription Model. `null` when neither applies.
 */
export async function dictationEngine(
  deps: ResolveDeps,
  userId: string,
): Promise<DictationEngine | null> {
  const resolved = await resolvePayer(
    deps,
    userId,
    dictationEngines.map((engine) => engine.provider),
    () => hostTranscriptionOffer(deps),
  );
  if (!resolved) return null;
  if (resolved.payer === "user") {
    const engine = dictationEngines.find((entry) => entry.provider === resolved.service)!;
    return {
      provider: engine.provider,
      id: `${engine.provider}:${engine.modelId}`,
      credentials: resolved.credentials,
      meter: freeMeter,
    };
  }
  const { entry, first } = resolved.offer;
  const id = `${entry.provider}:${first.model}`;
  return {
    provider: entry.provider,
    id,
    credentials: entry.credentials,
    meter: hostTranscriptionMeter(deps, userId, {
      provider: entry.provider,
      model: id,
      pricePerMinuteUsd: first.pricePerMinuteUsd,
    }),
  };
}

/**
 * Transcribes one recording with the user's engine, through TanStack AI's `generateTranscription`.
 * The audio is passed on and never kept. The engine's meter checks the Quota first and records the
 * call after it succeeds (ADR 0007). A Provider failure becomes a `DictationError`.
 */
export async function transcribeRecording(
  deps: ResolveDeps & Pick<ModelsDeps, "transcriptionAdapterFor">,
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
  const check = await engine.meter.mayRun();
  if (!check.ok) {
    throw new DictationError(
      "quota_exceeded",
      "You've used this window's Quota; try again after it resets",
      check.resetsAt,
    );
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
  await engine.meter.record({ durationSeconds, reportedSeconds: reportedSecondsOf(result) });
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
