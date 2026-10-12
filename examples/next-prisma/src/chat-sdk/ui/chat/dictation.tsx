import { Button } from "@/components/ui/button";
import { useAudioRecorder } from "@tanstack/ai-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2Icon, MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { dictationFailureMessage } from "../../core/client/voice";
import { useOrpc } from "../../core/client/react/provider";
import { maxDictationSeconds } from "../../core/shared/chat/voice";

/**
 * The mic beside Send (spec #249): shown only when the caller can dictate here, on their own
 * Provider key. The transcript goes to `onTranscript`; nothing is sent.
 */
export function Dictation({ onTranscript }: { onTranscript: (text: string) => void }) {
  const orpc = useOrpc();
  const status = useQuery(orpc.voice.status.queryOptions());
  if (!status.data?.transcription.available) return null;
  return <DictationButton onTranscript={onTranscript} />;
}

function DictationButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const orpc = useOrpc();
  const transcribe = useMutation(orpc.voice.transcribe.mutationOptions());
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
        toast.error("The recording couldn't be finished. Your message is unchanged.");
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
        toast.error(dictationFailureMessage(caught));
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
          ? "Microphone access is blocked. Allow it in your browser to dictate."
          : "The microphone couldn't start.",
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
        title="Transcribing"
        aria-label="Transcribing"
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
          title="Stop dictation"
          aria-label="Stop dictation"
        >
          <SquareIcon className="fill-current" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={() => recorder.cancel()}
          title="Cancel dictation"
          aria-label="Cancel dictation"
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
      title="Dictate"
      aria-label="Dictate"
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
