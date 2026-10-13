import type { AnyTranscriptionAdapter, TranscriptionOptions } from "@tanstack/ai";

export type FakeTranscription = {
  adapter: AnyTranscriptionAdapter;
  /** The options of every `transcribe` call, in order. */
  calls: TranscriptionOptions[];
};

/**
 * A transcription adapter for tests: it answers `text` for every recording, or throws `error`
 * (an error with a `status`, for example, to stand in for a Provider's refusal). `duration` is the
 * audio length the Provider reports, and `billedSeconds` the length it bills, as `usage.billed`.
 */
export function createFakeTranscription({
  model = "fake-transcription",
  text = "Hello there",
  error,
  duration,
  billedSeconds,
}: {
  model?: string;
  text?: string;
  error?: Error;
  duration?: number;
  billedSeconds?: number;
} = {}): FakeTranscription {
  const calls: TranscriptionOptions[] = [];
  const adapter: AnyTranscriptionAdapter = {
    kind: "transcription",
    name: "fake",
    model,
    "~types": { providerOptions: {} },
    transcribe: async (options) => {
      calls.push(options);
      if (error) throw error;
      return {
        id: "fake-transcription",
        model,
        text,
        duration,
        usage:
          billedSeconds === undefined
            ? undefined
            : {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                billed: { quantity: billedSeconds, unit: "seconds" },
              },
      };
    },
  };
  return { adapter, calls };
}
