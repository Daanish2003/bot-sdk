// PROTOTYPE (#574): in-memory stub of a Bot's Conversation, Helpers and hand-offs. Never merge to main.
import { createContext, type ReactNode, useContext, useState } from "react";

export type HelperType = "general" | "computer_use";
export type HelperStatus = "running" | "waiting" | "complete" | "error" | "stopped";

export type Helper = {
  id: string;
  type: HelperType;
  task: string;
  gist: string;
  status: HelperStatus;
  steps: number;
  latest: string;
  report?: string;
  reason?: string;
  startedAt: Date;
  endedAt?: Date;
};

export type Item =
  | { kind: "message"; id: string; role: "user" | "assistant"; text: string; at: Date }
  | { kind: "helperStarted"; id: string; helperId: string; at: Date }
  | { kind: "helperFinished"; id: string; helperId: string; at: Date }
  | { kind: "computerCard"; id: string; helperId: string; at: Date };

const t0 = new Date(Date.now() - 20 * 60_000);
const min = (n: number) => new Date(t0.getTime() + n * 60_000);

function initial(): { items: Item[]; helpers: Helper[] } {
  return {
    helpers: [
      {
        id: "h_3f2a",
        type: "computer_use",
        task: "Open Salesforce, find every lead from Acme Corp created this month, and list name, stage and owner.",
        gist: "Acme leads in Salesforce",
        status: "waiting",
        steps: 6,
        latest: "browser_navigate login.salesforce.com",
        reason: "Sign in to Salesforce so I can pull the Acme leads",
        startedAt: min(2),
      },
      {
        id: "h_91bc",
        type: "general",
        task: "Search the web for Acme Corp's last two press releases and summarise each in two lines.",
        gist: "Acme press releases",
        status: "running",
        steps: 4,
        latest: 'web_search "Acme Corp press release 2026"',
        startedAt: min(3),
      },
      {
        id: "h_07de",
        type: "general",
        task: "Count the rows in shared/leads.csv by stage.",
        gist: "Count leads by stage",
        status: "complete",
        steps: 3,
        latest: "shell python3 count.py",
        report:
          "leads.csv has 412 rows: 180 New, 121 Working, 77 Nurture, 34 Closed. Script at bots/b1/count.py.",
        startedAt: min(0),
        endedAt: min(1),
      },
    ],
    items: [
      {
        kind: "message",
        id: "m1",
        role: "user",
        text: "How many leads do we have by stage? And prep me for the Acme call at 3.",
        at: min(0),
      },
      {
        kind: "message",
        id: "m2",
        role: "assistant",
        text: "On it. I'll count the leads and pull Acme's details; I'll message you when they're in.",
        at: min(0),
      },
      { kind: "helperStarted", id: "s1", helperId: "h_07de", at: min(0) },
      { kind: "helperFinished", id: "f1", helperId: "h_07de", at: min(1) },
      {
        kind: "message",
        id: "m3",
        role: "assistant",
        text: "412 leads: 180 New, 121 Working, 77 Nurture, 34 Closed. Still working on Acme.",
        at: min(1),
      },
      { kind: "helperStarted", id: "s2", helperId: "h_3f2a", at: min(2) },
      { kind: "helperStarted", id: "s3", helperId: "h_91bc", at: min(3) },
      {
        kind: "message",
        id: "m4",
        role: "assistant",
        text: "Salesforce wants you to sign in. I've left the screen open for you.",
        at: min(4),
      },
      { kind: "computerCard", id: "c1", helperId: "h_3f2a", at: min(4) },
    ],
  };
}

type Store = ReturnType<typeof initial> & {
  log: string[];
  done: (id: string) => void;
  stop: (id?: string) => void;
  advance: () => void;
  start: (type: HelperType) => void;
  askUser: () => void;
  reset: () => void;
};

const Ctx = createContext<Store | null>(null);

export function HelpersProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((l) => [line, ...l].slice(0, 12));
  const now = () => new Date();
  const update = (id: string, patch: Partial<Helper>) =>
    setState((s) => ({
      ...s,
      helpers: s.helpers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }));
  const push = (item: Item) => setState((s) => ({ ...s, items: [...s.items, item] }));
  const finish = (h: Helper, status: HelperStatus, report: string) => {
    update(h.id, { status, report, endedAt: now(), reason: undefined });
    push({ kind: "helperFinished", id: `f_${h.id}_${Date.now()}`, helperId: h.id, at: now() });
  };

  const store: Store = {
    ...state,
    log,
    done: (id) => {
      update(id, {
        status: "running",
        reason: undefined,
        latest: "ask_user → The user tapped Done",
        steps: (state.helpers.find((h) => h.id === id)?.steps ?? 0) + 1,
      });
      note(`Done on ${id}: Helper running again (fresh job)`);
    },
    stop: (id) => {
      const targets = state.helpers.filter((h) =>
        id ? h.id === id : h.status === "running" || h.status === "waiting",
      );
      for (const h of targets)
        update(h.id, { status: "stopped", endedAt: now(), reason: undefined });
      note(`stop_helpers(${id ?? "all"}): ${targets.map((h) => h.id).join(", ") || "none"}`);
    },
    advance: () => {
      const running = state.helpers.filter((h) => h.status === "running");
      if (running.length === 0) return note("advance: nothing running");
      const h = running[0]!;
      if (h.steps >= 7) {
        const report =
          h.type === "general"
            ? "Two releases: (1) 2026-09-30 Acme opens a Berlin office, 40 hires planned. (2) 2026-10-10 Acme Q3 revenue up 18%, guidance raised."
            : "Found 5 Acme leads this month: Dana Li (Working, Sam), Omar Fitz (New, Sam), Ines Paz (New, Kim), Rui Ota (Nurture, Kim), Lea Moss (Working, Sam).";
        finish(h, "complete", report);
        note(`${h.id} finished → helper Trigger queued for the Bot`);
      } else {
        update(h.id, {
          steps: h.steps + 1,
          latest: h.type === "general" ? 'web_search "Acme Corp Q3"' : "browser_click ref=e42",
        });
        note(`${h.id} step ${h.steps + 1}`);
      }
    },
    start: (type) => {
      const id = `h_${Math.random().toString(16).slice(2, 6)}`;
      const h: Helper = {
        id,
        type,
        task:
          type === "general"
            ? "Draft three talking points for the Acme call from the notes in shared/acme.md."
            : "Book a 30-minute slot with Acme on calendly.com/acme for Thursday.",
        gist: type === "general" ? "Acme talking points" : "Book Acme slot",
        status: "running",
        steps: 0,
        latest: "starting",
        startedAt: now(),
      };
      setState((s) => ({
        ...s,
        helpers: [...s.helpers, h],
        items: [...s.items, { kind: "helperStarted", id: `s_${id}`, helperId: id, at: now() }],
      }));
      note(`start_helper(${type}) → ${id}`);
    },
    askUser: () => {
      const h = state.helpers.find((x) => x.type === "computer_use" && x.status === "running");
      if (!h) return note("ask_user: no running computer-use Helper");
      update(h.id, { status: "waiting", reason: "Enter the verification code Calendly sent you" });
      push({
        kind: "message",
        id: `m_${Date.now()}`,
        role: "assistant",
        text: "Enter the verification code Calendly sent you",
        at: now(),
      });
      push({ kind: "computerCard", id: `c_${Date.now()}`, helperId: h.id, at: now() });
      note(`${h.id} ask_user → waiting, job ended`);
    },
    reset: () => {
      setState(initial());
      setLog([]);
    },
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useHelpers(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("HelpersProvider missing");
  return s;
}

export function helperById(helpers: Helper[], id: string): Helper {
  return helpers.find((h) => h.id === id)!;
}

export const typeLabel = (t: HelperType) =>
  t === "general" ? "General Helper" : "Computer-use Helper";

export function time(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A rough stand-in for the noVNC live view: a 1280×800 Screen showing a login form. */
export function FakeScreen({ big, control }: { big?: boolean; control?: boolean }) {
  return (
    <div
      className={`relative aspect-[1280/800] w-full overflow-hidden rounded-md border bg-slate-100 dark:bg-slate-800 ${big ? "" : "max-w-sm"}`}
    >
      <div className="flex h-5 items-center gap-1 bg-slate-300 px-2 dark:bg-slate-700">
        <span className="size-1.5 rounded-full bg-red-400" />
        <span className="size-1.5 rounded-full bg-yellow-400" />
        <span className="size-1.5 rounded-full bg-green-400" />
        <span className="ml-2 truncate text-[8px] text-slate-600 dark:text-slate-300">
          login.salesforce.com
        </span>
      </div>
      <div className="m-auto mt-[8%] flex w-1/2 flex-col gap-1.5 rounded bg-white p-3 shadow dark:bg-slate-900">
        <div className="h-2 w-1/3 rounded bg-sky-500" />
        <div className="h-3 rounded border" />
        <div className="h-3 rounded border" />
        <div className="h-3 w-1/3 rounded bg-sky-600" />
      </div>
      <span className="absolute top-6 right-1.5 rounded bg-black/60 px-1.5 text-[9px] text-white">
        {control ? "You have control" : "View only"}
      </span>
    </div>
  );
}
