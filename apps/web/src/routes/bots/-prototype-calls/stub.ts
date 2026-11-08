// PROTOTYPE (#1366): in-memory stub data for the Call UI variants. Never merge to main.
import { useEffect, useState } from "react";

export type Msg =
  | {
      id: string;
      kind: "user";
      channel: "web" | "sms" | "phone";
      text: string;
      at: string;
      noTurn?: boolean;
    }
  | {
      id: string;
      kind: "bot";
      channel: "web" | "sms" | "phone";
      text: string;
      at: string;
      /** Spoken on the call, or kept in the thread only (its delegation was superseded). */
      spoken?: boolean;
      approval?: { action: string; answer?: "approved" | "denied"; duringCall?: boolean };
    }
  | { id: string; kind: "call-start"; at: string }
  | {
      id: string;
      kind: "call-end";
      at: string;
      minutes: number;
      reason: "hung up" | "10-minute cap";
    };

export const callMessages: Msg[] = [
  { id: "c0", kind: "call-start", at: "14:02" },
  {
    id: "c1",
    kind: "user",
    channel: "phone",
    at: "14:02",
    text: "What's on my calendar tomorrow?",
  },
  { id: "c2", kind: "bot", channel: "phone", at: "14:02", text: "On it.", spoken: true },
  {
    id: "c3",
    kind: "bot",
    channel: "phone",
    at: "14:03",
    spoken: true,
    text: "Three things: standup at 9, dentist at 11, and dinner with Sam at 7.",
  },
  {
    id: "c4",
    kind: "user",
    channel: "phone",
    at: "14:03",
    text: "Move the dentist to Friday same time.",
  },
  {
    id: "c5",
    kind: "bot",
    channel: "phone",
    at: "14:04",
    spoken: true,
    text: "I need your OK to move it. I've sent an approval to your app.",
    approval: { action: "calendar.update_event · Dentist → Fri 11:00", duringCall: true },
  },
  {
    id: "c6",
    kind: "user",
    channel: "phone",
    at: "14:05",
    text: "Actually, also what's the weather Friday?",
  },
  {
    id: "c7",
    kind: "bot",
    channel: "phone",
    at: "14:05",
    spoken: false,
    text: "Still checking the dentist's availability…",
  },
  {
    id: "c8",
    kind: "bot",
    channel: "phone",
    at: "14:05",
    spoken: true,
    text: "Friday looks sunny, 24 degrees.",
  },
];

export const afterCall: Msg[] = [
  {
    id: "e1",
    kind: "user",
    channel: "phone",
    at: "14:06",
    text: "Great, thanks, bye.",
    noTurn: true,
  },
  { id: "e2", kind: "call-end", at: "14:06", minutes: 4, reason: "hung up" },
  {
    id: "e3",
    kind: "bot",
    channel: "web",
    at: "14:20",
    text: "My Helper finished: the dentist confirmed Friday 11:00 is free once you approve.",
  },
];

export const before: Msg[] = [
  { id: "b1", kind: "user", channel: "sms", at: "09:12", text: "Remind me to call mum tonight" },
  { id: "b2", kind: "bot", channel: "sms", at: "09:12", text: "Done, I'll text you at 7pm." },
];

export function useStub() {
  const [live, setLive] = useState(true);
  const [seconds, setSeconds] = useState(134);
  const [answers, setAnswers] = useState<Record<string, "approved" | "denied">>({});
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const withAnswers = (list: Msg[]) =>
    list.map((m) =>
      m.kind === "bot" && m.approval && answers[m.id]
        ? { ...m, approval: { ...m.approval, answer: answers[m.id] } }
        : m,
    );
  const messages = withAnswers([...before, ...callMessages, ...(live ? [] : afterCall)]);
  return {
    live,
    setLive,
    clock: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    messages,
    answer: (id: string, answer: "approved" | "denied") =>
      setAnswers((a) => ({ ...a, [id]: answer })),
  };
}
export type Stub = ReturnType<typeof useStub>;

export type CallsSetup = {
  sms: { number: string };
  calls: null | {
    projectId: string;
    status: "waiting" | "working" | "needs_attention";
    lastCall?: string;
  };
};

export const webhookUrl = "https://lab.example.dev/api/bots/channels/phone/openai/acc_01JD8Q";

export const telnyxChecklist = [
  "Mission Control → Voice → SIP Trunking → new FQDN connection: sip.api.openai.com, A record, port 5061",
  "Inbound transport TLS, and Encrypted media: SRTP Mandatory",
  "Codecs: Opus, plus PCMU/PCMA (no Media Streaming)",
  "Numbers → your number → assign the connection; Voice → Translated Number = your OpenAI project ID",
  "OpenAI → project → Webhooks: add the URL above, event live.transport.incoming, copy the signing secret",
];
