// PROTOTYPE (#460 "Bot UI in apps/web"): three variants of the step 1 Bot experience, switchable
// via `?variant=A|B|C` on /bots-prototype. Stub data in memory; nothing reaches the server.
// Stub Turn rule: a Message containing "?" gets a reply; anything else and the Bot stays quiet.
// Throwaway: lives on branch prototype/460-bot-ui, never merged to main.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

export const Route = createFileRoute("/_auth/bots-prototype")({
  validateSearch: z.object({ variant: z.enum(["A", "B", "C"]).optional() }),
  component: BotsPrototype,
});

const VARIANTS = [
  { key: "A", name: "A page inside the assistant shell" },
  { key: "B", name: "Own Bot app, slide 8" },
  { key: "C", name: "Messenger, one pane" },
];

// ---------- stub state ----------

type Msg = { id: string; from: "user" | "bot"; text: string; at: number };
type QuietTurn = { afterId: string; at: number };
type Bot = {
  id: string;
  name: string;
  model: string;
  messages: Msg[];
  quiet: QuietTurn[];
  working: boolean;
};

const MODELS = ["anthropic:claude-sonnet-5-5", "openai:gpt-5.5", "google:gemini-3-pro"];
let seq = 0;
const id = () => `m${++seq}`;
const t0 = Date.now() - 3600_000;

const SEED: Bot[] = [
  {
    id: "b1",
    name: "Sales Outbound",
    model: MODELS[0]!,
    working: false,
    messages: [
      { id: "s1", from: "user", text: "Can you draft outreach for the Acme list?", at: t0 },
      {
        id: "s2",
        from: "bot",
        text: "Drafted 8 outreaches. Want me to send them?",
        at: t0 + 60_000,
      },
      { id: "s3", from: "user", text: "Not yet, thanks", at: t0 + 120_000 },
    ],
    quiet: [{ afterId: "s3", at: t0 + 125_000 }],
  },
  {
    id: "b2",
    name: "Chief of Staff",
    model: MODELS[1]!,
    working: false,
    messages: [
      { id: "s4", from: "user", text: "What's on my plate tomorrow?", at: t0 + 600_000 },
      { id: "s5", from: "bot", text: "Two meetings and the board deck review.", at: t0 + 640_000 },
    ],
    quiet: [],
  },
  { id: "b3", name: "Inbox Manager", model: MODELS[0]!, working: false, messages: [], quiet: [] },
];

function useBots() {
  const [bots, setBots] = useState<Bot[]>(SEED);
  const update = (botId: string, fn: (b: Bot) => Bot) =>
    setBots((all) => all.map((b) => (b.id === botId ? fn(b) : b)));

  const send = (botId: string, text: string) => {
    const userMsg: Msg = { id: id(), from: "user", text, at: Date.now() };
    update(botId, (b) => ({ ...b, messages: [...b.messages, userMsg], working: true }));
    setTimeout(() => {
      update(botId, (b) =>
        text.includes("?")
          ? {
              ...b,
              working: false,
              messages: [
                ...b.messages,
                {
                  id: id(),
                  from: "bot",
                  text: `(${b.name}) Here's my answer to: ${text}`,
                  at: Date.now(),
                },
              ],
            }
          : { ...b, working: false, quiet: [...b.quiet, { afterId: userMsg.id, at: Date.now() }] },
      );
    }, 1500);
  };
  const create = (name: string, model: string) => {
    const bot: Bot = { id: id(), name, model, messages: [], quiet: [], working: false };
    setBots((all) => [bot, ...all]);
    return bot.id;
  };
  return { bots, send, create };
}

type Api = ReturnType<typeof useBots>;

const last = (b: Bot) => b.messages.at(-1);
const preview = (b: Bot) => {
  const m = b.messages.filter((x) => x.from === "bot").at(-1);
  return m ? m.text : "No messages yet";
};
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hue = (name: string) => [...name].reduce((h, c) => h + c.charCodeAt(0), 0) % 360;

function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        background: `hsl(${hue(name)} 55% 45%)`,
        fontSize: size * 0.4,
      }}
    >
      {name
        .split(" ")
        .map((w) => w[0])
        .slice(0, 2)
        .join("")}
    </div>
  );
}

function Composer({ onSend, placeholder }: { onSend: (t: string) => void; placeholder: string }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) onSend(text.trim());
    setText("");
  };
  return (
    <form onSubmit={submit} className="flex gap-2 border-t p-3">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
      />
      <button
        type="submit"
        className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
      >
        Send
      </button>
    </form>
  );
}

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border bg-background px-2 py-2 text-sm"
    >
      {MODELS.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

// ---------- Variant A: a Bots page inside the assistant shell ----------
// The assistant's sidebar stays. The page has its own Bot list column. Quiet Turns show nothing.

function VariantA({ api }: { api: Api }) {
  const [selected, setSelected] = useState(api.bots[0]!.id);
  const [name, setName] = useState("");
  const [model, setModel] = useState(MODELS[0]!);
  const bot = api.bots.find((b) => b.id === selected) ?? api.bots[0]!;
  return (
    <div className="flex h-full min-h-0 flex-1">
      <aside className="flex w-72 flex-col border-r">
        <form
          className="flex flex-col gap-2 border-b p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            setSelected(api.create(name.trim(), model));
            setName("");
          }}
        >
          <div className="text-xs font-semibold uppercase text-muted-foreground">New Bot</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <ModelSelect value={model} onChange={setModel} />
            <button type="submit" className="rounded-md border px-3 text-sm">
              Create
            </button>
          </div>
        </form>
        <ul className="flex-1 overflow-y-auto">
          {api.bots.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setSelected(b.id)}
                className={`w-full px-3 py-2 text-left text-sm ${b.id === bot.id ? "bg-muted" : ""}`}
              >
                <div className="font-medium">{b.name}</div>
                <div className="truncate text-xs text-muted-foreground">{preview(b)}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="border-b px-4 py-3">
          <div className="font-semibold">{bot.name}</div>
          <div className="text-xs text-muted-foreground">{bot.model}</div>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {bot.messages.length === 0 && (
            <p className="text-sm text-muted-foreground">Say something to {bot.name}.</p>
          )}
          {bot.messages.map((m) => (
            <div key={m.id} className="text-sm">
              <div className="text-xs font-semibold text-muted-foreground">
                {m.from === "user" ? "You" : bot.name} · {time(m.at)}
              </div>
              <div className="whitespace-pre-wrap">{m.text}</div>
            </div>
          ))}
          {bot.working && <p className="text-xs text-muted-foreground">{bot.name} is working…</p>}
        </div>
        <Composer onSend={(t) => api.send(bot.id, t)} placeholder={`Message ${bot.name}`} />
      </section>
    </div>
  );
}

// ---------- Variant B: its own Bot app, like slide 8 ----------
// Covers the assistant shell. Sidebar of Bots with avatars and last-message previews.
// New Bot is a dialog. A quiet Turn marks your Message "Seen".

function VariantB({ api }: { api: Api }) {
  const [selected, setSelected] = useState(api.bots[0]!.id);
  const [creating, setCreating] = useState(false);
  const bot = api.bots.find((b) => b.id === selected) ?? api.bots[0]!;
  const sorted = [...api.bots].sort(
    (a, b) => (last(b)?.at ?? Infinity) - (last(a)?.at ?? Infinity),
  );
  return (
    <div className="fixed inset-0 z-40 flex bg-background">
      <aside className="flex w-80 flex-col border-r bg-muted/40">
        <div className="flex items-center justify-between p-4">
          <a href="/c" className="text-xs text-muted-foreground">
            ← Assistant
          </a>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-full bg-primary px-3 py-1 text-sm text-primary-foreground"
          >
            + New Bot
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {sorted.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => setSelected(b.id)}
                className={`flex w-full gap-3 px-4 py-3 text-left ${b.id === bot.id ? "bg-muted" : ""}`}
              >
                <Avatar name={b.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between text-sm font-medium">
                    <span>{b.name}</span>
                    {last(b) && (
                      <span className="text-xs text-muted-foreground">{time(last(b)!.at)}</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {b.working ? "Working…" : preview(b)}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <Avatar name={bot.name} size={28} />
          <div className="font-semibold">{bot.name}</div>
        </header>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {bot.messages.map((m) => {
            const quiet = bot.quiet.some((q) => q.afterId === m.id);
            return (
              <div
                key={m.id}
                className={`flex flex-col ${m.from === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm ${
                    m.from === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                  }`}
                >
                  {m.text}
                </div>
                {quiet && <span className="mt-0.5 text-[10px] text-muted-foreground">Seen ✓</span>}
              </div>
            );
          })}
          {bot.working && (
            <div className="w-fit rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">
              •••
            </div>
          )}
        </div>
        <Composer onSend={(t) => api.send(bot.id, t)} placeholder={`Message ${bot.name}`} />
      </section>
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreate={(n, m) => {
            setSelected(api.create(n, m));
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function CreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, model: string) => void;
}) {
  const [name, setName] = useState("");
  const [model, setModel] = useState(MODELS[0]!);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onCreate(name.trim(), model);
        }}
        className="flex w-96 flex-col gap-3 rounded-lg bg-background p-5"
      >
        <h2 className="font-semibold">New Bot</h2>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name, e.g. Inbox Manager"
          className="rounded-md border bg-background px-3 py-2 text-sm"
        />
        <ModelSelect value={model} onChange={setModel} />
        <button
          type="submit"
          className="rounded-md bg-primary py-2 text-sm text-primary-foreground"
        >
          Create
        </button>
      </form>
    </div>
  );
}

// ---------- Variant C: a messenger, one pane at a time ----------
// Home is the list of Bots; a Bot's Conversation takes the whole screen. New Bot is its own screen.
// A quiet Turn leaves a faint line in the Conversation.

function VariantC({ api }: { api: Api }) {
  const [screen, setScreen] = useState<"home" | "new" | string>("home");
  const [name, setName] = useState("");
  const [model, setModel] = useState(MODELS[0]!);
  const bot = api.bots.find((b) => b.id === screen);

  return (
    <div className="fixed inset-0 z-40 flex justify-center bg-muted/30">
      <div className="flex w-full max-w-xl flex-col bg-background shadow">
        {screen === "home" && (
          <>
            <header className="flex items-end justify-between p-5">
              <h1 className="text-3xl font-bold">Bots</h1>
              <a href="/c" className="text-xs text-muted-foreground">
                Assistant →
              </a>
            </header>
            <ul className="flex-1 overflow-y-auto">
              {api.bots.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => setScreen(b.id)}
                    className="flex w-full items-center gap-4 border-b px-5 py-4 text-left"
                  >
                    <Avatar name={b.name} size={48} />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{b.name}</div>
                      <div className="truncate text-sm text-muted-foreground">
                        {b.working ? "Working…" : preview(b)}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setScreen("new")}
              className="m-5 rounded-full bg-primary py-3 text-primary-foreground"
            >
              + New Bot
            </button>
          </>
        )}
        {screen === "new" && (
          <form
            className="flex flex-1 flex-col gap-4 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              setScreen(api.create(name.trim(), model));
              setName("");
            }}
          >
            <button type="button" onClick={() => setScreen("home")} className="self-start text-sm">
              ← Back
            </button>
            <h1 className="text-2xl font-bold">Name your Bot</h1>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Inbox Manager"
              className="rounded-md border bg-background px-3 py-3"
            />
            <label className="flex flex-col gap-1 text-sm">
              Model
              <ModelSelect value={model} onChange={setModel} />
            </label>
            {name.trim() && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <Avatar name={name} /> This is how {name} will look.
              </div>
            )}
            <button
              type="submit"
              className="mt-auto rounded-full bg-primary py-3 text-primary-foreground"
            >
              Create
            </button>
          </form>
        )}
        {bot && (
          <>
            <header className="flex items-center gap-3 border-b p-3">
              <button type="button" onClick={() => setScreen("home")}>
                ←
              </button>
              <Avatar name={bot.name} size={32} />
              <div className="font-semibold">{bot.name}</div>
            </header>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {bot.messages.length === 0 && (
                <div className="mt-20 flex flex-col items-center gap-2 text-sm text-muted-foreground">
                  <Avatar name={bot.name} size={64} />
                  {bot.name} messages you only when there's something to say.
                </div>
              )}
              {bot.messages.map((m) => (
                <div key={m.id}>
                  <div className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                        m.from === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                  {bot.quiet.some((q) => q.afterId === m.id) && (
                    <p className="mt-2 text-center text-xs text-muted-foreground">
                      {bot.name} had nothing to say
                    </p>
                  )}
                </div>
              ))}
              {bot.working && (
                <p className="text-center text-xs text-muted-foreground">{bot.name} is working…</p>
              )}
            </div>
            <Composer onSend={(t) => api.send(bot.id, t)} placeholder="Message" />
          </>
        )}
      </div>
    </div>
  );
}

// ---------- switcher ----------

function BotsPrototype() {
  const { variant = "A" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const api = useBots();
  return (
    <>
      {variant === "A" && <VariantA api={api} />}
      {variant === "B" && <VariantB api={api} />}
      {variant === "C" && <VariantC api={api} />}
      <PrototypeSwitcher
        variants={VARIANTS}
        current={variant}
        onChange={(v) => navigate({ search: { variant: v as "A" | "B" | "C" }, replace: true })}
      />
    </>
  );
}
