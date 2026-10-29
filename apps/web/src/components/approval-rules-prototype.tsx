/*
 * PROTOTYPE, throw away (#988, Approval rules map #973). Three variants of the Custom Rules
 * settings and the pending Approvals ("Waiting for you") UI on the existing /bots/$botId page,
 * switchable via `?variant=A|B|C`. Stub data in memory: nothing here calls the server.
 */
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNavigate } from "@tanstack/react-router";
import {
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HandIcon,
  InboxIcon,
  LockIcon,
  ShieldAlertIcon,
  ShieldIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

type Mode = "without" | "preapproved" | "ask" | "handoff";

const modes: { key: Mode; label: string; hint: string }[] = [
  { key: "without", label: "Without asking", hint: "Counts as your permission" },
  { key: "preapproved", label: "If pre-approved", hint: "Only when you asked for it" },
  { key: "ask", label: "Ask before", hint: "Always waits for your Approval" },
  { key: "handoff", label: "Hand off to me", hint: "You do it yourself" },
];

type Rule = { id: string; text: string; mode: Mode };
type Pending = {
  id: string;
  kind: "call" | "rule";
  summary: string;
  detail: string;
  reason: string;
  bot: string;
  expires: string;
  mode?: Mode;
};

const seedRules: Rule[] = [
  { id: "r1", text: "Reply to emails from anyone @acme.com", mode: "without" },
  { id: "r2", text: "Delete files outside ~/scratch", mode: "ask" },
  { id: "r3", text: "Anything on my bank's website", mode: "handoff" },
];

const seedPending: Pending[] = [
  {
    id: "p1",
    kind: "call",
    summary: "Send an email to jane@acme.com",
    detail: 'gmail.send { to: "jane@acme.com", subject: "Q3 numbers", body: "Hi Jane, …" }',
    reason: "You asked for a draft, not to send it.",
    bot: "Scout",
    expires: "in 6 days",
  },
  {
    id: "p2",
    kind: "call",
    summary: "Delete 214 files in ~/old-photos",
    detail: "rm -rf ~/old-photos",
    reason: "Deleting files you didn't name can't be undone.",
    bot: "Scout",
    expires: "in 3 days",
  },
  {
    id: "p3",
    kind: "rule",
    summary: "New rule: Accept calendar invites from my team",
    detail: "Proposed after you approved this 3 times this week.",
    reason: "Scout proposes this Custom Rule.",
    bot: "Scout",
    expires: "in 7 days",
    mode: "without",
  },
];

const neverAllowed = [
  "Moving money between accounts, or trading securities or crypto",
  "Acting on someone else's account",
  "Changing passwords, two-factor or recovery settings",
  "Sending a Secret, card or ID number off the Computer",
  "Weakening the Bot's own safety",
];

function usePrototypeState() {
  const [rules, setRules] = useState(seedRules);
  const [pending, setPending] = useState(seedPending);
  const [log, setLog] = useState<string[]>([]);
  const answer = (id: string, yes: boolean) => {
    const item = pending.find((p) => p.id === id);
    if (!item) return;
    setPending((all) => all.filter((p) => p.id !== id));
    if (yes && item.kind === "rule")
      setRules((all) => [
        ...all,
        { id, text: item.summary.replace("New rule: ", ""), mode: item.mode! },
      ]);
    setLog((l) => [`${yes ? "Approved" : "Denied"}: ${item.summary}`, ...l]);
  };
  const setMode = (id: string, mode: Mode) =>
    setRules((all) => all.map((r) => (r.id === id ? { ...r, mode } : r)));
  const setText = (id: string, text: string) =>
    setRules((all) => all.map((r) => (r.id === id ? { ...r, text } : r)));
  const add = () => setRules((all) => [...all, { id: crypto.randomUUID(), text: "", mode: "ask" }]);
  const remove = (id: string) => setRules((all) => all.filter((r) => r.id !== id));
  return { rules, pending, log, answer, setMode, setText, add, remove };
}

type State = ReturnType<typeof usePrototypeState>;

const modeIcon = (mode: Mode) =>
  mode === "handoff" ? (
    <HandIcon className="size-3.5" />
  ) : mode === "ask" ? (
    <ShieldAlertIcon className="size-3.5" />
  ) : (
    <ShieldIcon className="size-3.5" />
  );

function ModeSegments({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {modes.map((m) => (
        <button
          key={m.key}
          type="button"
          title={m.hint}
          onClick={() => onChange(m.key)}
          className={`rounded-full border px-2 py-0.5 text-xs ${value === m.key ? "border-foreground bg-foreground text-background" : "text-muted-foreground"}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function PendingCard({ item, state, compact }: { item: Pending; state: State; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-amber-400 bg-amber-50 p-2.5 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlertIcon className="size-4 shrink-0 text-amber-600" />
        {item.summary}
      </div>
      <div className="text-xs">{item.reason}</div>
      {!compact && (
        <pre className="rounded bg-background/70 px-2 py-1 text-xs break-all whitespace-pre-wrap">
          {item.detail}
        </pre>
      )}
      <div className="flex items-center gap-2">
        <Button size="xs" onClick={() => state.answer(item.id, true)}>
          Approve
        </Button>
        <Button size="xs" variant="outline" onClick={() => state.answer(item.id, false)}>
          Deny
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {item.bot} · expires {item.expires}
        </span>
      </div>
    </div>
  );
}

function RuleRow({ rule, state }: { rule: Rule; state: State }) {
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border p-2">
      <div className="flex items-start gap-2">
        <textarea
          value={rule.text}
          maxLength={500}
          rows={1}
          placeholder="Describe the action in your own words"
          onChange={(e) => state.setText(rule.id, e.target.value)}
          className="flex-1 resize-none bg-transparent text-sm outline-none"
        />
        <button type="button" aria-label="Delete rule" onClick={() => state.remove(rule.id)}>
          <XIcon className="size-3.5 text-muted-foreground" />
        </button>
      </div>
      <ModeSegments value={rule.mode} onChange={(m) => state.setMode(rule.id, m)} />
    </li>
  );
}

function NeverList() {
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
      {neverAllowed.map((n) => (
        <li key={n} className="flex items-center gap-1.5">
          <LockIcon className="size-3 shrink-0" />
          {n}
        </li>
      ))}
    </ul>
  );
}

function RulesFootnote() {
  return (
    <p className="text-xs text-muted-foreground">
      Rules reach only calls Auto-review checks: shell commands, browser actions that do more than
      look, and Connector tools. Up to 50 rules.
    </p>
  );
}

/* A: one header button, "Waiting 3", opening a tabbed popover like Memory and Skills. */
function VariantA({ state }: { state: State }) {
  const [tab, setTab] = useState<"waiting" | "rules" | "never">("waiting");
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <InboxIcon /> Waiting {state.pending.length}
      </PopoverTrigger>
      <PopoverContent className="w-[26rem]" align="end">
        <div className="flex gap-1 border-b pb-2">
          {(
            [
              ["waiting", `Waiting for you (${state.pending.length})`],
              ["rules", `Rules (${state.rules.length})`],
              ["never", "Never allowed"],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="xs"
              variant={tab === key ? "secondary" : "ghost"}
              onClick={() => setTab(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        {tab === "waiting" &&
          (state.pending.length ? (
            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
              {state.pending.map((p) => (
                <PendingCard key={p.id} item={p} state={state} compact />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">Nothing waits for you.</p>
          ))}
        {tab === "rules" && (
          <div className="flex flex-col gap-2">
            <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
              {state.rules.map((r) => (
                <RuleRow key={r.id} rule={r} state={state} />
              ))}
            </ul>
            <Button size="sm" variant="outline" onClick={state.add}>
              Add a rule
            </Button>
            <RulesFootnote />
          </div>
        )}
        {tab === "never" && (
          <div className="flex flex-col gap-2">
            <p className="text-xs">
              Your Bots never do these, even if you ask. They tell you to do it yourself.
            </p>
            <NeverList />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/* B: a docked right-hand panel, always open: waiting cards with the full call on top, then a
 * rules table with a mode dropdown, then Never allowed folded away. */
function VariantB({ state }: { state: State }) {
  return (
    <aside className="fixed top-14 right-0 bottom-0 z-40 flex w-96 flex-col gap-4 overflow-y-auto border-l bg-background p-4">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Waiting for you · {state.pending.length}</h2>
        {state.pending.map((p) => (
          <PendingCard key={p.id} item={p} state={state} />
        ))}
        {!state.pending.length && <p className="text-xs text-muted-foreground">All clear.</p>}
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex items-center">
          <h2 className="text-sm font-semibold">Your rules</h2>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={state.add}>
            + Add
          </Button>
        </div>
        <table className="text-sm">
          <tbody>
            {state.rules.map((r) => (
              <tr key={r.id} className="border-b align-top">
                <td className="py-1.5 pr-2">
                  <input
                    value={r.text}
                    maxLength={500}
                    placeholder="When the Bot wants to…"
                    onChange={(e) => state.setText(r.id, e.target.value)}
                    className="w-full bg-transparent outline-none"
                  />
                </td>
                <td className="py-1.5">
                  <select
                    value={r.mode}
                    onChange={(e) => state.setMode(r.id, e.target.value as Mode)}
                    className="rounded border bg-background px-1 text-xs"
                  >
                    {modes.map((m) => (
                      <option key={m.key} value={m.key}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <RulesFootnote />
      </section>
      <details className="text-sm">
        <summary className="cursor-pointer font-semibold">Never allowed</summary>
        <div className="pt-2">
          <NeverList />
        </div>
      </details>
    </aside>
  );
}

/* C: a slim banner over the thread opens a full-screen review, one item at a time (inbox zero);
 * rules are a board with one column per mode, Never allowed a locked fifth column. */
function VariantC({ state }: { state: State }) {
  const [open, setOpen] = useState<"review" | "rules" | null>(null);
  const current = state.pending[0];
  return (
    <>
      <div className="fixed top-14 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-amber-400 bg-amber-50 px-4 py-1.5 text-sm shadow dark:bg-amber-950/60">
        <ShieldAlertIcon className="size-4 text-amber-600" />
        {state.pending.length ? `${state.pending.length} things wait for you` : "Nothing waits"}
        {!!state.pending.length && (
          <Button size="xs" onClick={() => setOpen("review")}>
            Review
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => setOpen("rules")}>
          Rules
        </Button>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 p-6">
          <div className="mb-4 flex items-center">
            <h2 className="text-lg font-semibold">
              {open === "review" ? "Waiting for you" : "Rules for all your Bots"}
            </h2>
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => setOpen(null)}
            >
              <XIcon />
            </Button>
          </div>
          {open === "review" &&
            (current ? (
              <div className="mx-auto flex w-full max-w-lg flex-col gap-3">
                <div className="text-xs text-muted-foreground">
                  1 of {state.pending.length} · from {current.bot}
                </div>
                <div className="text-xl font-medium">{current.summary}</div>
                <div>{current.reason}</div>
                <pre className="rounded bg-muted p-3 text-sm whitespace-pre-wrap">
                  {current.detail}
                </pre>
                <div className="text-xs text-muted-foreground">Expires {current.expires}</div>
                <div className="flex gap-2">
                  <Button onClick={() => state.answer(current.id, true)}>Approve</Button>
                  <Button variant="outline" onClick={() => state.answer(current.id, false)}>
                    Deny
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mx-auto text-muted-foreground">All done.</p>
            ))}
          {open === "rules" && (
            <div className="grid flex-1 grid-cols-5 gap-3 overflow-y-auto">
              {modes.map((m) => (
                <div key={m.key} className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    {modeIcon(m.key)} {m.label}
                  </div>
                  <div className="text-xs text-muted-foreground">{m.hint}</div>
                  {state.rules
                    .filter((r) => r.mode === m.key)
                    .map((r) => (
                      <div key={r.id} className="rounded border bg-background p-2 text-sm">
                        <textarea
                          value={r.text}
                          rows={2}
                          maxLength={500}
                          onChange={(e) => state.setText(r.id, e.target.value)}
                          className="w-full resize-none bg-transparent outline-none"
                        />
                        <div className="flex gap-1">
                          {modes
                            .filter((o) => o.key !== m.key)
                            .map((o) => (
                              <button
                                key={o.key}
                                type="button"
                                title={`Move to ${o.label}`}
                                onClick={() => state.setMode(r.id, o.key)}
                                className="text-muted-foreground"
                              >
                                {modeIcon(o.key)}
                              </button>
                            ))}
                          <button
                            type="button"
                            className="ml-auto text-muted-foreground"
                            onClick={() => state.remove(r.id)}
                          >
                            <XIcon className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      state.add();
                    }}
                  >
                    + Add
                  </Button>
                </div>
              ))}
              <div className="flex flex-col gap-2 rounded-lg border border-dashed p-2">
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  <BanIcon className="size-3.5" /> Never allowed
                </div>
                <div className="text-xs text-muted-foreground">Set by the app. Can't change.</div>
                <NeverList />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

const variants = { A: "Header popover", B: "Docked panel", C: "Banner + full-screen" } as const;
export type PrototypeVariant = keyof typeof variants;

function Switcher({ current, log }: { current: PrototypeVariant; log: string[] }) {
  const navigate = useNavigate();
  const keys = Object.keys(variants) as PrototypeVariant[];
  const go = (step: number) => {
    const next = keys[(keys.indexOf(current) + step + keys.length) % keys.length];
    void navigate({ to: ".", search: { variant: next }, replace: true });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!import.meta.env.DEV) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-1">
      {log[0] && (
        <div className="rounded bg-black/70 px-2 py-0.5 text-xs text-white">Last: {log[0]}</div>
      )}
      <div className="flex items-center gap-2 rounded-full bg-fuchsia-600 px-3 py-1 text-sm text-white shadow-lg">
        <button type="button" aria-label="Previous variant" onClick={() => go(-1)}>
          <ChevronLeftIcon className="size-4" />
        </button>
        {current} ({variants[current]})
        <button type="button" aria-label="Next variant" onClick={() => go(1)}>
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Mounts the chosen variant: `header` goes in the Bot header, `overlay` over the page. */
export function useApprovalRulesPrototype(variant: PrototypeVariant): {
  header: ReactNode;
  overlay: ReactNode;
} {
  const state = usePrototypeState();
  return {
    header: variant === "A" ? <VariantA state={state} /> : null,
    overlay: (
      <>
        {variant === "B" && <VariantB state={state} />}
        {variant === "C" && <VariantC state={state} />}
        <Switcher current={variant} log={state.log} />
      </>
    ),
  };
}
