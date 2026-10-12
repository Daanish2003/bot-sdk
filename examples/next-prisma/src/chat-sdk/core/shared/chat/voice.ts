/**
 * Dictation's contract, shared by the server, the RPC client and the composer (spec #249). No
 * server code: safe to import into the browser.
 */

/** The longest recording that is transcribed. The browser stops there; the server refuses more. */
export const maxDictationSeconds = 600;

/** The largest audio one transcription sends: the OpenAI and Groq upload cap. */
export const maxDictationBytes = 25 * 1024 * 1024;

/** The audio types a recording may have, without their codec parameters. */
export const dictationAudioTypes = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
] as const;

/** A recording's type without its parameters: `audio/webm;codecs=opus` is `audio/webm`. */
export function dictationAudioType(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

export function isDictationAudioType(mimeType: string): boolean {
  return (dictationAudioTypes as readonly string[]).includes(dictationAudioType(mimeType));
}

/** Why a dictation failed, as the composer tells it. */
export type DictationErrorReason = "unavailable" | "invalid_key" | "rate_limited" | "failed";
