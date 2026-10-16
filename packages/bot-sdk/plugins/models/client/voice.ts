import type { I18n, MessageKey } from "../../../core/shared/i18n";
import type { DictationErrorReason } from "../shared/voice";
import { quotaResetsAt } from "./quota";
import { RateLimitedError } from "../../../core/client/rate-limit";

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

const failureKeys: Record<DictationErrorReason, MessageKey> = {
  unavailable: "chat.dictationNeedsKey",
  quota_exceeded: "chat.dictationQuotaOff",
  invalid_key: "chat.dictationKeyRejected",
  rate_limited: "chat.dictationBusy",
  failed: "chat.dictationFailed",
};

/**
 * The toast text for a failed transcription, from the error the RPC call threw. The reset time is
 * formatted in the dictionary's locale.
 */
export function dictationFailureMessage(caught: unknown, i18n: I18n): string {
  const { t } = i18n;
  if (caught instanceof RateLimitedError) {
    return t("chat.dictationTooManyRecordings", { seconds: caught.retryAfterSeconds });
  }
  const data = (caught as { data?: { reason?: unknown; resetsAt?: unknown } } | null)?.data;
  if (data?.reason === "quota_exceeded" && typeof data.resetsAt === "string") {
    return t("chat.dictationQuotaOffUntil", {
      reset: quotaResetsAt(data.resetsAt, i18n.locale),
    });
  }
  return t(failureKeys[data?.reason as DictationErrorReason] ?? failureKeys.failed);
}
