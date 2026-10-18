// PROTOTYPE (#542): in-memory stub data for the Routines and Check-ins UI. Nothing is saved.
import { type ReactNode, createContext, useContext, useState } from "react";

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  /** A schedule Routine has days + at; a webhook Routine has a URL instead (never both). */
  days?: string;
  at?: string;
  webhookUrl?: string;
  timeZone: string;
  state: "pending" | "active" | "paused";
  /** The Bot Message whose Turn created it: where the approval card sits. */
  createdAfter: string;
  nextRun?: string;
};

export type CheckIn = {
  id: string;
  at: string;
  note: string;
  state: "pending" | "fired" | "cancelled";
  setAfter: string;
};

/** Where a Turn's Triggers came from (provenance), as the UI would show it. */
export type Via = {
  source: "routine" | "check_in";
  channel: "schedule" | "webhook";
  name: string;
  at: string;
};

export type Item =
  | { kind: "message"; id: string; role: "user" | "bot"; text: string; via?: Via }
  /** A Turn that ran from a Routine or Check-in and sent nothing. */
  | { kind: "quiet"; id: string; via: Via };

const initialItems: Item[] = [
  {
    kind: "message",
    id: "m1",
    role: "user",
    text: "Every weekday morning, pick eligible prospects from the Sheet, research them and draft outreach.",
  },
  {
    kind: "message",
    id: "m2",
    role: "bot",
    text: "I set up Sales Outbound for weekdays at 8:00. Tap Approve and it starts tomorrow.",
  },
  { kind: "message", id: "m3", role: "user", text: "Also check whether Acme replied by Thursday." },
  { kind: "message", id: "m4", role: "bot", text: "I'll check on Thursday at 9:00." },
  {
    kind: "message",
    id: "m5",
    role: "bot",
    text: "Morning brief: 3 meetings today, Acme replied overnight, and the board deck is due Friday.",
    via: { source: "routine", channel: "schedule", name: "morning-brief", at: "Mon 19 Oct 08:00" },
  },
  {
    kind: "message",
    id: "m6",
    role: "bot",
    text: "A Stripe payout of $1,240 landed. Nothing looks off.",
    via: { source: "routine", channel: "webhook", name: "stripe-payouts", at: "Mon 19 Oct 11:42" },
  },
  {
    kind: "quiet",
    id: "q1",
    via: { source: "routine", channel: "schedule", name: "morning-brief", at: "Tue 20 Oct 08:00" },
  },
];

const initialRoutines: Routine[] = [
  {
    id: "r1",
    name: "sales-outbound",
    prompt:
      "Pick eligible prospects from the Outbound Google Sheet, research each on the web, pull contacts and accounts from Hex and Salesforce, and draft a first outreach for each.",
    days: "weekdays",
    at: "08:00",
    timeZone: "Europe/London",
    state: "pending",
    createdAfter: "m2",
  },
  {
    id: "r2",
    name: "morning-brief",
    prompt: "Summarize today's calendar, overnight replies and anything due this week.",
    days: "weekdays",
    at: "08:00",
    timeZone: "Europe/London",
    state: "active",
    createdAfter: "m0",
    nextRun: "Wed 21 Oct 08:00",
  },
  {
    id: "r3",
    name: "stripe-payouts",
    prompt:
      "A payout webhook arrived. Check it against the expected amount and tell me only if something is off or it's over $1,000.",
    webhookUrl: "https://ai-chat.local/api/routines/webhook/7f3c…e91a",
    timeZone: "Europe/London",
    state: "active",
    createdAfter: "m0",
  },
];

const initialCheckIns: CheckIn[] = [
  {
    id: "c1",
    at: "Thu 22 Oct 09:00",
    note: "Did Acme reply to the pricing email?",
    state: "pending",
    setAfter: "m4",
  },
];

function useScheduleState() {
  const [items] = useState(initialItems);
  const [routines, setRoutines] = useState(initialRoutines);
  const [checkIns, setCheckIns] = useState(initialCheckIns);
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((prev) => [line, ...prev].slice(0, 8));
  const patch = (id: string, change: Partial<Routine>) =>
    setRoutines((prev) => prev.map((r) => (r.id === id ? { ...r, ...change } : r)));

  return {
    items,
    routines,
    checkIns,
    log,
    approve: (id: string) => {
      patch(id, { state: "active", nextRun: "Wed 21 Oct 08:00" });
      note(`approve ${id}: state → active, first fire enqueued`);
    },
    decline: (id: string) => {
      setRoutines((prev) => prev.filter((r) => r.id !== id));
      note(`decline ${id}: Routine deleted`);
    },
    pause: (id: string) => {
      patch(id, { state: "paused", nextRun: undefined });
      note(`pause ${id}: queued fire cancelled, untaken Triggers dropped`);
    },
    resume: (id: string) => {
      patch(id, { state: "active", nextRun: "Wed 21 Oct 08:00" });
      note(`resume ${id}: next fire enqueued (no fresh OK)`);
    },
    remove: (id: string) => {
      setRoutines((prev) => prev.filter((r) => r.id !== id));
      note(`delete ${id}`);
    },
    rotate: (id: string) => {
      patch(id, {
        webhookUrl: `https://ai-chat.local/api/routines/webhook/${Math.random().toString(16).slice(2, 6)}…new`,
      });
      note(`rotate ${id}: old URL now 404`);
    },
    cancelCheckIn: (id: string) => {
      setCheckIns((prev) => prev.map((c) => (c.id === id ? { ...c, state: "cancelled" } : c)));
      note(`cancel check-in ${id}`);
    },
    reset: () => {
      setRoutines(initialRoutines);
      setCheckIns(initialCheckIns);
      setLog([]);
    },
  };
}

export type Schedule = ReturnType<typeof useScheduleState>;

const ScheduleContext = createContext<Schedule | null>(null);

/** Lives above the variants, so switching variants keeps the state. */
export function ScheduleProvider({ children }: { children: ReactNode }) {
  const value = useScheduleState();
  return <ScheduleContext.Provider value={value}>{children}</ScheduleContext.Provider>;
}

export function useSchedule(): Schedule {
  const value = useContext(ScheduleContext);
  if (!value) throw new Error("useSchedule outside ScheduleProvider");
  return value;
}

export function scheduleText(routine: Routine): string {
  return routine.webhookUrl ? "on webhook" : `${routine.days} ${routine.at}`;
}

export function viaText(via: Via): string {
  if (via.source === "check_in") return `Check-in · ${via.at}`;
  return via.channel === "webhook"
    ? `${via.name} · webhook · ${via.at}`
    : `${via.name} · ${via.at}`;
}
