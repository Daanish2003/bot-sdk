// PROTOTYPE (#623): stub Bot memory held in React state. Nothing reaches the server.
// Shapes follow the map's decisions: plain files per Bot (profile.md, log/YYYY-MM.md, notes.md),
// Profiles shared across Bots, Log/Notes private, top 30 Log lines by importance × decay,
// Notes 2 days in the prompt, a post-turn pass that adds/replaces/removes lines.
import { createContext, type ReactNode, useContext, useState } from "react";

export const today = "2026-10-20";

export type Tier = "profile" | "log" | "notes";

export type Line = {
  id: string;
  /** The Bot whose file holds the line. */
  bot: string;
  tier: Tier;
  text: string;
  /** Log and Notes only. */
  date?: string;
  /** Log only, 1–10. */
  importance?: number;
};

export type Change = { kind: "add" | "replace" | "remove"; tier: Tier; text: string; was?: string };

export type ThreadItem =
  | { kind: "user"; text: string }
  | { kind: "bot"; text: string; changes?: Change[]; undone?: boolean };

export const thisBot = "Sales Outbound";
export const otherBots = ["Personal", "Research"];

const seed: Line[] = [
  {
    id: "p1",
    bot: thisBot,
    tier: "profile",
    text: "Name is Daanish; works at a seed-stage startup",
  },
  {
    id: "p2",
    bot: thisBot,
    tier: "profile",
    text: "Prefers short replies, bullet points over prose",
  },
  { id: "p3", bot: thisBot, tier: "profile", text: "Time zone: Asia/Kolkata" },
  { id: "p4", bot: "Personal", tier: "profile", text: "Vegetarian" },
  {
    id: "p5",
    bot: "Personal",
    tier: "profile",
    text: "Prefers short replies, bullet points over prose",
  },
  { id: "p6", bot: "Research", tier: "profile", text: "Reads papers on agent memory" },
  {
    id: "l1",
    bot: thisBot,
    tier: "log",
    date: "2026-10-18",
    importance: 8,
    text: "Closed the Acme pilot; contract signed",
  },
  {
    id: "l2",
    bot: thisBot,
    tier: "log",
    date: "2026-10-12",
    importance: 4,
    text: "Sent 40 LinkedIn intros for the Q4 list",
  },
  {
    id: "l3",
    bot: thisBot,
    tier: "log",
    date: "2026-09-02",
    importance: 6,
    text: "User moved the weekly metrics call to Fridays",
  },
  {
    id: "l4",
    bot: thisBot,
    tier: "log",
    date: "2026-07-14",
    importance: 3,
    text: "Drafted cold email v1 (replaced since)",
  },
  {
    id: "n1",
    bot: thisBot,
    tier: "notes",
    date: "2026-10-20",
    text: "Waiting on Acme's procurement to send the PO",
  },
  {
    id: "n2",
    bot: thisBot,
    tier: "notes",
    date: "2026-10-19",
    text: "User is travelling until Thursday",
  },
  {
    id: "n3",
    bot: thisBot,
    tier: "notes",
    date: "2026-10-15",
    text: "Prospect list CSV is at ~/leads/q4.csv",
  },
];

const seedThread: ThreadItem[] = [
  { kind: "user", text: "Acme signed! Also, keep replies short please." },
  {
    kind: "bot",
    text: "Congrats! Logged it. I'll keep things short.",
    changes: [
      { kind: "add", tier: "log", text: "Closed the Acme pilot; contract signed" },
      {
        kind: "replace",
        tier: "profile",
        text: "Prefers short replies, bullet points over prose",
        was: "Prefers detailed replies",
      },
    ],
  },
];

export function ageDays(date: string): number {
  return Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
}

/** The map's Log score: (0.75 + 0.05 × importance) × 0.5^(ageDays / 30). */
export function score(line: Line): number {
  return (0.75 + 0.05 * (line.importance ?? 5)) * 0.5 ** (ageDays(line.date ?? today) / 30);
}

/** What this Bot's prompt holds right now. */
export function inPrompt(lines: Line[]): Set<string> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const bot of [thisBot, ...otherBots])
    for (const l of lines.filter((x) => x.tier === "profile" && x.bot === bot))
      if (!seen.has(l.text)) {
        seen.add(l.text);
        ids.add(l.id);
      }
  lines
    .filter((l) => l.tier === "log" && l.bot === thisBot)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 3) // 30 in the real thing; 3 here so some fall out
    .forEach((l) => ids.add(l.id));
  lines
    .filter((l) => l.tier === "notes" && l.bot === thisBot && ageDays(l.date!) <= 2)
    .forEach((l) => ids.add(l.id));
  return ids;
}

/** The raw text of one of this Bot's files, as the Bot would `cat` it. */
export function fileText(lines: Line[], bot: string, tier: Tier): string {
  return lines
    .filter((l) => l.bot === bot && l.tier === tier)
    .map((l) =>
      tier === "profile"
        ? `- ${l.text}`
        : tier === "log"
          ? `- ${l.date} (importance ${l.importance}) ${l.text}`
          : `- ${l.date} ${l.text}`,
    )
    .join("\n");
}

export function filePath(bot: string, tier: Tier): string {
  const dir = `bots/${bot.toLowerCase().replace(/\s+/g, "-")}/memory`;
  return tier === "profile"
    ? `${dir}/profile.md`
    : tier === "log"
      ? `${dir}/log/2026-10.md`
      : `${dir}/notes.md`;
}

function useMemoryState() {
  const [lines, setLines] = useState(seed);
  const [thread, setThread] = useState(seedThread);
  const [log, setLog] = useState<string[]>([]);
  const note = (s: string) => setLog((l) => [...l, s]);
  let n = lines.length;
  return {
    lines,
    thread,
    log,
    edit(id: string, text: string) {
      setLines((ls) => ls.map((l) => (l.id === id ? { ...l, text } : l)));
      note(`user edit ${id}`);
    },
    remove(id: string) {
      setLines((ls) => ls.filter((l) => l.id !== id));
      note(`user delete ${id}`);
    },
    add(tier: Tier, text: string) {
      setLines((ls) => [
        ...ls,
        {
          id: `u${++n}`,
          bot: thisBot,
          tier,
          text,
          date: tier === "profile" ? undefined : today,
          importance: tier === "log" ? 5 : undefined,
        },
      ]);
      note(`user add ${tier}`);
    },
    /** A whole file replaced from a plain-text editor. */
    saveFile(tier: Tier, text: string) {
      const parsed = text
        .split("\n")
        .map((s) => s.replace(/^-\s*/, "").trim())
        .filter(Boolean)
        .map((raw, i): Line => {
          if (tier === "profile") return { id: `f${tier}${i}`, bot: thisBot, tier, text: raw };
          const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(?:\(importance (\d+)\)\s+)?(.*)$/);
          return {
            id: `f${tier}${i}`,
            bot: thisBot,
            tier,
            date: m?.[1] ?? today,
            importance: tier === "log" ? Number(m?.[2] ?? 5) : undefined,
            text: m?.[3] ?? raw,
          };
        });
      setLines((ls) => [...ls.filter((l) => !(l.bot === thisBot && l.tier === tier)), ...parsed]);
      note(`user saved ${tier} file`);
    },
    /** Simulates a Turn plus its post-turn pass. */
    turn() {
      setThread((t) => [
        ...t,
        { kind: "user", text: "Forget the travel thing, I'm back. I'm vegan now, not vegetarian." },
        {
          kind: "bot",
          text: "Welcome back! Noted.",
          changes: [
            { kind: "remove", tier: "notes", text: "User is travelling until Thursday" },
            { kind: "add", tier: "profile", text: "Vegan" },
          ],
        },
      ]);
      setLines((ls) => [
        ...ls.filter((l) => l.id !== "n2"),
        { id: `t${++n}`, bot: thisBot, tier: "profile", text: "Vegan" },
      ]);
      note(
        "turn + pass: remove n2, add profile 'Vegan' (Personal's 'Vegetarian' is another Bot's file: not shown, not removed)",
      );
    },
    undo(index: number) {
      setThread((t) =>
        t.map((item, i) => (i === index && item.kind === "bot" ? { ...item, undone: true } : item)),
      );
      note(`undo changes of thread item ${index}`);
    },
    reset() {
      setLines(seed);
      setThread(seedThread);
      setLog([]);
    },
  };
}

type MemoryState = ReturnType<typeof useMemoryState>;
const Ctx = createContext<MemoryState | null>(null);

export function MemoryProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={useMemoryState()}>{children}</Ctx.Provider>;
}

export function useMemory(): MemoryState {
  const s = useContext(Ctx);
  if (!s) throw new Error("no MemoryProvider");
  return s;
}

export const tierLabel: Record<Tier, string> = { profile: "Profile", log: "Log", notes: "Notes" };
