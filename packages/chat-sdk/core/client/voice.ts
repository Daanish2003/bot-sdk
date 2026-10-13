import type { DictationErrorReason } from "../shared/chat/voice";
import { quotaResetsAt } from "./quota";
import { RateLimitedError } from "./rate-limit";

/**
 * The composer's text once a transcript is in: after what is there, with a space between, so the
 * user edits it before sending (spec #249). A blank transcript leaves the text as it was.
 */
export function appendTranscript(current: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return current;
  if (!current.trim()) return text;
  return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`;
}

const failureText: Record<DictationErrorReason, string> = {
  unavailable: "Dictation needs an OpenAI, Groq or Grok key of yours in Keys & settings.",
  quota_exceeded: "Dictation is off until your Quota resets.",
  invalid_key: "Dictation failed: your key was rejected. Check it in Keys & settings.",
  rate_limited: "Dictation failed: the Provider is busy. Try again in a moment.",
  failed: "Dictation failed. Your message is unchanged.",
};

/**
 * The toast text for a failed transcription, from the error the RPC call threw. The reset time is
 * formatted in `locale`.
 */
export function dictationFailureMessage(caught: unknown, locale: string): string {
  if (caught instanceof RateLimitedError) {
    return `Too many recordings. Try again in ${caught.retryAfterSeconds} seconds.`;
  }
  const data = (caught as { data?: { reason?: unknown; resetsAt?: unknown } } | null)?.data;
  if (data?.reason === "quota_exceeded" && typeof data.resetsAt === "string") {
    return `Dictation is off until ${quotaResetsAt(data.resetsAt, locale)}, when your Quota resets.`;
  }
  return failureText[data?.reason as DictationErrorReason] ?? failureText.failed;
}
