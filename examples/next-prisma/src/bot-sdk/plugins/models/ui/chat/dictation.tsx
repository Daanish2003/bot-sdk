import { Button } from "@/components/ui/button";
import { AudioRecorder, useAudioRecorder } from "@tanstack/ai-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, MicIcon, MicOffIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { quotaExceeded, quotaResetsAt } from "../../client/quota";
import { useQuota } from "../../client/react/quota";
import { dictationFailureMessage } from "../../client/voice";
import { useI18n, useOrpc } from "../../../../core/client/react/provider";
import { maxDictationSeconds } from "../../shared/voice";

/**
 * The mic beside Send (spec #249): shown only when the caller can dictate here, on their own key or
 * the Host's transcription Model. The transcript goes to `onTranscript`; nothing is sent. On the
 * Host's Model the mic is disabled at the Quota's limit, with the reset time (ADR 0007).
 */
export function Dictation({ onTranscript }: { onTranscript: (text: string) => void }) {
  const orpc = useOrpc();
  const status = useQuery(orpc.voice.status.queryOptions());
  const quota = useQuota().data;
  const transcription = status.data?.transcription;
  if (!transcription?.available || !AudioRecorder.isSupported()) return null;
  if (transcription.onHostCredentials && quota && quotaExceeded(quota)) {
    return <DictationOff resetsAt={quota.resetsAt} />;
  }
  return <DictationButton onTranscript={onTranscript} />;
}

/** The mic at the Quota's limit on the Host's Model: disabled, with the time the Quota resets. */
function DictationOff({ resetsAt }: { resetsAt: Date | string }) {
  const i18n = useI18n();
  const reset = quotaResetsAt(resetsAt, i18n.locale);
  const label = i18n.t("chat.dictationOffUntil", { reset });
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>{i18n.t("chat.quotaResets", { reset })}</span>
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        disabled
        title={label}
        aria-label={label}
      >
        <MicOffIcon />
      </Button>
    </div>
  );
}

function DictationButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const queryClient = useQueryClient();
  // A transcription on the Host's Model spends the Quota, so the composer's meter is read again.
  const transcribe = useMutation(
    orpc.voice.transcribe.mutationOptions({
      onSettled: () => void queryClient.invalidateQueries({ queryKey: orpc.quota.read.queryKey() }),
    }),
  );
  const recorder = useAudioRecorder();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // One stop at a time: a second press, or the limit firing again, must not transcribe twice.
  const stopping = useRef(false);
  const stopAndTranscribe = async () => {
    if (stopping.current) return;
    stopping.current = true;
    try {
      let recording;
      try {
        recording = await recorder.stop();
      } catch {
        toast.error(t("chat.recordingNotFinished"));
        return;
      }
      try {
        const { text } = await transcribe.mutateAsync({
          audio: recording.base64,
          mimeType: recording.mimeType,
          // A recording stopped at the limit can run a fraction past it; the server caps at the limit.
          durationSeconds: Math.min(recording.durationMs / 1000, maxDictationSeconds),
        });
        onTranscript(text);
      } catch (caught) {
        toast.error(dictationFailureMessage(caught, i18n));
      }
    } finally {
      stopping.current = false;
    }
  };

  const start = async () => {
    setElapsedSeconds(0);
    try {
      await recorder.start();
    } catch (caught) {
      toast.error(
        (caught as Error).name === "NotAllowedError"
          ? t("chat.micBlocked")
          : t("chat.micStartFailed"),
      );
    }
  };

  // The recording ends itself at the limit, as if Stop were pressed.
  const stopAtLimit = useEffectEvent(() => void stopAndTranscribe());
  useEffect(() => {
    if (!recorder.isRecording) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      setElapsedSeconds(seconds);
      if (seconds >= maxDictationSeconds) stopAtLimit();
    }, 500);
    return () => clearInterval(timer);
  }, [recorder.isRecording]);

  if (!recorder.isSupported) return null;

  if (transcribe.isPending) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        disabled
        title={t("chat.transcribing")}
        aria-label={t("chat.transcribing")}
      >
        <Loader2Icon className="animate-spin" />
      </Button>
    );
  }

  if (recorder.isRecording) {
    return (
      <div
        role="status"
        className="flex items-center gap-1 rounded-full bg-destructive/10 pl-3 text-xs text-destructive"
      >
        <span className="tabular-nums">{formatElapsed(elapsedSeconds)}</span>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={() => void stopAndTranscribe()}
          title={t("chat.stopDictation")}
          aria-label={t("chat.stopDictation")}
        >
          <SquareIcon className="fill-current" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={() => recorder.cancel()}
          title={t("chat.cancelDictation")}
          aria-label={t("chat.cancelDictation")}
        >
          <XIcon />
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="rounded-full"
      onClick={() => void start()}
      title={t("chat.dictate")}
      aria-label={t("chat.dictate")}
    >
      <MicIcon />
    </Button>
  );
}

/** A recording's length as the timer shows it: `m:ss`. */
function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
