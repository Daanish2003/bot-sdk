// PROTOTYPE (#760): in-memory stub for the Channels UI variants. No server, no schema.
import { useState } from "react";

export const DOMAIN = "mail.botsdk.dev";
export type Via = "web" | "email";

export type Rich =
  | { type: "choice"; question: string; options: string[]; allowOther: boolean; answer?: string }
  | { type: "files"; files: { name: string; kb: number }[] }
  | { type: "secret"; label: string; done?: boolean };

export type Msg = {
  id: number;
  from: "user" | "bot";
  text: string;
  /** User Message: which Channel it arrived by. */
  via?: Via;
  /** Bot Message: also delivered by email. */
  emailed?: boolean;
  /** At most one Rich control. */
  rich?: Rich;
  /** The user's reaction on a Bot Message. */
  userReaction?: string;
  /** The Bot's reaction on a user Message. */
  botReaction?: string;
};

const randomId = () => Math.random().toString(36).slice(2, 10).padEnd(8, "x");

const seed = (): Msg[] => [
  {
    id: 1,
    from: "user",
    via: "web",
    text: "Can you pull together the Q3 numbers?",
    botReaction: "👀",
  },
  {
    id: 2,
    from: "bot",
    text: "Done. The report and the raw data are attached.",
    rich: {
      type: "files",
      files: [
        { name: "q3-report.pdf", kb: 412 },
        { name: "q3-data.csv", kb: 58 },
      ],
    },
  },
  {
    id: 3,
    from: "bot",
    text: "I need the billing API key to refresh the numbers weekly.",
    rich: { type: "secret", label: "BILLING_API_KEY" },
  },
  {
    id: 4,
    from: "bot",
    text: "Which format should the weekly summary use?",
    rich: {
      type: "choice",
      question: "Weekly summary format",
      options: ["Short bullets", "Full report", "Just the chart"],
      allowOther: true,
    },
  },
];

export function useChannelsStub() {
  const [messages, setMessages] = useState<Msg[]>(seed);
  const [local, setLocal] = useState(() => `planner.${randomId()}`);
  const [rotations, setRotations] = useState(0);
  const [lastWrote, setLastWrote] = useState<Via>("web");
  const [copied, setCopied] = useState(false);
  const address = `${local}@${DOMAIN}`;
  const nextId = () => Date.now() + Math.random();

  return {
    messages,
    address,
    rotations,
    lastWrote,
    copied,
    /** A user Message arrives by email; the Bot replies by email (Web shows everything). */
    emailArrives() {
      setLastWrote("email");
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          from: "user",
          via: "email",
          text: "Sent from my phone: please also include last year's Q3 for comparison.",
        },
        {
          id: nextId(),
          from: "bot",
          emailed: true,
          text: "Got it, adding last year's Q3 as a comparison column.",
        },
      ]);
    },
    /** A Bot-initiated Message follows the Channel the user last wrote from. */
    botPings() {
      setMessages((m) => [
        ...m,
        {
          id: nextId(),
          from: "bot",
          emailed: lastWrote === "email",
          text: "Heads up: the Q3 numbers changed after a late invoice.",
        },
      ]);
    },
    /** First answer wins. */
    answer(id: number, value: string) {
      setMessages((m) =>
        m.map((x) =>
          x.id === id && x.rich?.type === "choice" && !x.rich.answer
            ? { ...x, rich: { ...x.rich, answer: value } }
            : x,
        ),
      );
    },
    resolveSecret(id: number) {
      setMessages((m) =>
        m.map((x) =>
          x.id === id && x.rich?.type === "secret" ? { ...x, rich: { ...x.rich, done: true } } : x,
        ),
      );
    },
    /** Max one reaction each way per Message; toggling clears it. */
    reactUser(id: number, emoji = "❤️") {
      setMessages((m) =>
        m.map((x) =>
          x.id === id && x.from === "bot"
            ? { ...x, userReaction: x.userReaction === emoji ? undefined : emoji }
            : x,
        ),
      );
    },
    botReacts() {
      setMessages((m) => {
        const target = [...m].reverse().find((x) => x.from === "user" && !x.botReaction);
        return target ? m.map((x) => (x.id === target.id ? { ...x, botReaction: "👍" } : x)) : m;
      });
    },
    rotate() {
      setLocal(`planner.${randomId()}`);
      setRotations((r) => r + 1);
    },
    copy() {
      void navigator.clipboard?.writeText(address).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    },
    reset() {
      setMessages(seed());
      setLastWrote("web");
      setRotations(0);
    },
  };
}

export type Stub = ReturnType<typeof useChannelsStub>;

export function kb(n: number) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} MB` : `${n} KB`;
}
