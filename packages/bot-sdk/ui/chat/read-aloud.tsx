import { Button } from "@/components/ui/button";
import type { MessagePart } from "@tanstack/ai";
import { SquareIcon, Volume2Icon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useI18n } from "../../core/client/react/provider";
import {
  pickOnDeviceVoice,
  readAloudUtterances,
} from "../../plugins/assistant/shared/chat/read-aloud";

/**
 * Read-aloud (#257) with the browser's on-device voices. One Message reads at a time: the module
 * state below is the only one, so a row never needs to know about another.
 */

/** Which Message is being read, if any. */
let speakingId: string | null = null;
/** Bumped at each start and stop, so callbacks of a finished reading do nothing. */
let session = 0;
/** Kept until the reading ends: some browsers drop an utterance nothing references. */
let queued: SpeechSynthesisUtterance[] = [];
const listeners = new Set<() => void>();

function setSpeaking(id: string | null) {
  speakingId = id;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window
    ? window.speechSynthesis
    : null;
}

/** Stops the Message being read, if any. */
function stopReading() {
  session += 1;
  queued = [];
  synth()?.cancel();
  setSpeaking(null);
}

/** Reads a Message aloud, stopping any other Message first. */
function readAloud(messageId: string, utterances: string[]) {
  const speech = synth();
  if (!speech || utterances.length === 0) return;
  stopReading();
  const current = session;
  const voice = pickOnDeviceVoice(
    speech.getVoices(),
    document.documentElement.lang || navigator.language,
  );
  queued = utterances.map((text) => {
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.onend = () => {
      if (current !== session) return;
      if (utterance === queued.at(-1)) stopReading();
    };
    utterance.onerror = () => {
      if (current === session) stopReading();
    };
    return utterance;
  });
  setSpeaking(messageId);
  for (const utterance of queued) speech.speak(utterance);
}

/** Whether the browser lists a voice that runs on this device. Empty until the browser has them. */
function useHasOnDeviceVoice() {
  const [has, setHas] = useState(false);
  useEffect(() => {
    const speech = synth();
    if (!speech) return;
    const check = () => setHas(speech.getVoices().some((voice) => voice.localService));
    check();
    speech.addEventListener("voiceschanged", check);
    return () => speech.removeEventListener("voiceschanged", check);
  }, []);
  return has;
}

/** The read-aloud control beside Copy on a finished assistant Message. Absent without an on-device voice. */
export function ReadAloud({ messageId, parts }: { messageId: string; parts: MessagePart[] }) {
  const available = useHasOnDeviceVoice();
  const speaking = useSyncExternalStore(
    subscribe,
    () => speakingId === messageId,
    () => false,
  );

  // Leaving the Conversation unmounts the row: reading it stops with it.
  useEffect(
    () => () => {
      if (speakingId === messageId) stopReading();
    },
    [messageId],
  );

  if (!available) return null;
  return (
    <ReadAloudButton
      speaking={speaking}
      onToggle={() => (speaking ? stopReading() : readAloud(messageId, readAloudUtterances(parts)))}
    />
  );
}

export function ReadAloudButton({
  speaking,
  onToggle,
}: {
  speaking: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const label = speaking ? t("chat.stopReading") : t("chat.readAloud");
  return (
    <Button variant="ghost" size="icon-xs" onClick={onToggle} title={label} aria-label={label}>
      {speaking ? <SquareIcon /> : <Volume2Icon />}
    </Button>
  );
}
