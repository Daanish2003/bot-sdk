/*
 * PROTOTYPE, throw away (#1039, "How a Rich control shows on each Channel"). Three variants of how
 * one Bot Message with a Rich control shows on Telegram, Slack and SMS, switchable via
 * `?variant=A|B|C`, plus `?text=split|cut` for a Message past the platform's length limit.
 * Mock chats in memory: nothing here calls the server. The panel on the right shows the Trigger the
 * Bot would get back.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

const variants = { A: "Native buttons", B: "Text replies", C: "Open in app" } as const;
type Variant = keyof typeof variants;
type TextMode = "split" | "cut";

export const Route = createFileRoute("/prototype/channel-messages")({
  validateSearch: (s: Record<string, unknown>): { variant?: Variant; text?: TextMode } => ({
    variant: s.variant === "B" || s.variant === "C" ? s.variant : undefined,
    text: s.text === "cut" ? "cut" : undefined,
  }),
  component: Page,
});

type Platform = "telegram" | "slack" | "sms";
type Scenario = "choice" | "approval" | "files" | "password" | "long";

const scenarios: Record<Scenario, { label: string; text: string; options?: string[] }> = {
  choice: {
    label: "Choice",
    text: "I found three flights to Lisbon on Friday. Which one should I hold?",
    options: ["07:10 TAP, €182", "11:45 easyJet, €96", "18:30 Ryanair, €74"],
  },
  approval: {
    label: "Approval",
    text: "I'm about to send the invoice email to accounts@acme.com with the PDF attached.",
    options: ["Approve", "Deny"],
  },
  files: {
    label: "Files",
    text: "Send me last month's bank statements (PDF) and I'll reconcile them.",
  },
  password: {
    label: "Password entry",
    text: "I need your Notion password to sign in on my Computer.",
  },
  long: {
    label: "Long text",
    text:
      "**Weekly summary**\n\n" +
      Array.from(
        { length: 14 },
        (_, i) =>
          `- Day ${i + 1}: reviewed the _inbox_, archived newsletters, drafted replies to two clients, and moved the \`Q4 plan\` doc forward with notes from Tuesday's call.`,
      ).join("\n"),
  },
};

const limits: Record<Platform, number> = { telegram: 4096, slack: 3000, sms: 1600 };
const appLink = "https://bots.example/b/ada?m=8f2c";

/** What one variant sends on one platform: chat bubbles, each with optional buttons. */
type Bubble = { text: string; buttons?: string[]; link?: string };

function render(
  variant: Variant,
  platform: Platform,
  scenario: Scenario,
  mode: TextMode,
): Bubble[] {
  const s = scenarios[scenario];
  const native = variant === "A" && platform !== "sms";
  if (scenario === "long") return longText(s.text, platform, mode);
  if (scenario === "password")
    // Never typed into a chat: always a link to the secure entry field, in every variant.
    return [{ text: s.text, link: "Enter it securely in the app" }];
  if (variant === "C") return [{ text: s.text, link: "Open in app to answer" }];
  if (scenario === "files")
    return [
      {
        text: `${s.text}\n\n${platform === "sms" ? "Reply with the files attached (MMS), or open the app." : "Attach them in a reply here."}`,
        link: platform === "sms" ? "Upload in the app" : undefined,
      },
    ];
  const options = s.options!;
  if (native) return [{ text: s.text, buttons: options }];
  const keys = scenario === "approval" ? ["YES", "NO"] : options.map((_, i) => String(i + 1));
  return [
    {
      text: `${s.text}\n\n${options.map((o, i) => `${keys[i]}  ${o}`).join("\n")}\n\nReply ${keys.join(", ")}.`,
      link: variant === "B" ? undefined : "Or answer in the app",
    },
  ];
}

function longText(text: string, platform: Platform, mode: TextMode): Bubble[] {
  const plain = platform === "sms" ? text.replace(/[*_`]/g, "") : text;
  const limit = limits[platform];
  if (plain.length <= limit) return [{ text: plain }];
  if (mode === "cut")
    return [{ text: `${plain.slice(0, limit - 60)}…`, link: "Read the rest in the app" }];
  const parts: Bubble[] = [];
  for (let i = 0; i < plain.length; i += limit - 10)
    parts.push({ text: plain.slice(i, i + limit - 10) });
  return parts.map((p, i) => ({
    text: `${p.text}${parts.length > 1 ? ` (${i + 1}/${parts.length})` : ""}`,
  }));
}

/** Telegram's MarkdownV2, Slack's mrkdwn and SMS plain text, drawn roughly. */
function Markup({ text, platform }: { text: string; platform: Platform }) {
  if (platform === "sms") return <span className="whitespace-pre-wrap">{text}</span>;
  const html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/_(.+?)_/g, "<i>$1</i>")
    .replace(/`(.+?)`/g, '<code class="rounded bg-black/10 px-1">$1</code>');
  return <span className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: html }} />;
}

const chrome: Record<Platform, { name: string; head: string; bubble: string; button: string }> = {
  telegram: {
    name: "Telegram · @ada_bot",
    head: "bg-sky-600 text-white",
    bubble: "bg-white text-black rounded-2xl rounded-bl-sm",
    button: "rounded-lg bg-sky-500/90 text-white",
  },
  slack: {
    name: "Slack · Ada (DM)",
    head: "bg-purple-900 text-white",
    bubble: "bg-transparent text-black",
    button: "rounded border border-gray-300 bg-white text-gray-900 font-medium",
  },
  sms: {
    name: "SMS · +1 555 0134",
    head: "bg-gray-200 text-black",
    bubble: "bg-gray-200 text-black rounded-2xl rounded-bl-sm",
    button: "",
  },
};

function Chat({
  platform,
  bubbles,
  onAnswer,
  reply,
}: {
  platform: Platform;
  bubbles: Bubble[];
  onAnswer: (answer: string, how: string) => void;
  reply: string | null;
}) {
  const c = chrome[platform];
  const [draft, setDraft] = useState("");
  return (
    <div className="flex h-[560px] w-80 flex-col overflow-hidden rounded-xl border bg-white shadow">
      <div className={`px-3 py-2 text-sm font-semibold ${c.head}`}>{c.name}</div>
      <div
        className={`flex flex-1 flex-col gap-2 overflow-y-auto p-3 text-sm ${platform === "telegram" ? "bg-[#cfe3c6]" : "bg-white"}`}
      >
        {bubbles.map((b, i) => (
          <div key={i} className="flex flex-col gap-1">
            {platform === "slack" && i === 0 && (
              <div className="text-xs font-bold text-black">Ada APP</div>
            )}
            <div className={`max-w-[95%] px-3 py-2 ${c.bubble}`}>
              <Markup text={b.text} platform={platform} />
              {b.link && (
                <div className="mt-1">
                  {platform === "slack" ? (
                    <button type="button" className={`mt-1 px-2 py-1 text-xs ${c.button}`}>
                      {b.link} ↗
                    </button>
                  ) : (
                    <span className="text-blue-600 underline">
                      {b.link}: {appLink}
                    </span>
                  )}
                </div>
              )}
              {b.buttons && platform === "slack" && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {b.buttons.map((o) => (
                    <button
                      key={o}
                      type="button"
                      className={`px-2 py-1 text-xs ${c.button} ${o === "Approve" ? "border-green-700 bg-green-700 text-white" : ""} ${o === "Deny" ? "text-red-700" : ""}`}
                      onClick={() => onAnswer(o, "button press (block_actions)")}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {b.buttons && platform === "telegram" && (
              <div className="grid gap-1">
                {b.buttons.map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={`px-2 py-1.5 text-xs ${c.button}`}
                    onClick={() => onAnswer(o, "button press (callback_query)")}
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {reply && (
          <div className="self-end rounded-2xl rounded-br-sm bg-blue-500 px-3 py-2 text-white">
            {reply}
          </div>
        )}
      </div>
      <form
        className="flex gap-1 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) onAnswer(draft.trim(), "typed reply");
          setDraft("");
        }}
      >
        <input
          className="flex-1 rounded border px-2 py-1 text-sm text-black"
          placeholder="Reply…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>
    </div>
  );
}

/** How the Bot reads a reply: a button names its option; a typed "2" or "yes" maps to one. */
function triggerFor(scenario: Scenario, answer: string, how: string) {
  const options = scenarios[scenario].options;
  if (!options) return { kind: "Message", text: answer, how };
  const byKey = /^\d+$/.test(answer) ? options[Number(answer) - 1] : undefined;
  const byYesNo = /^y(es)?$/i.test(answer) ? "Approve" : /^no?$/i.test(answer) ? "Deny" : undefined;
  const chosen = options.includes(answer) ? answer : (byKey ?? byYesNo);
  return chosen
    ? { kind: "Rich control answer", chosen, how }
    : { kind: "Message (not an answer: the control stays open)", text: answer, how };
}

function Page() {
  const { variant = "A", text = "split" } = Route.useSearch();
  const navigate = useNavigate();
  const [scenario, setScenario] = useState<Scenario>("choice");
  const [replies, setReplies] = useState<Partial<Record<Platform, string>>>({});
  const [trigger, setTrigger] = useState<object | null>(null);
  const [last, setLast] = useState<string>();

  const pick = (s: Scenario) => {
    setScenario(s);
    setReplies({});
    setTrigger(null);
  };
  const platforms: Platform[] = ["telegram", "slack", "sms"];
  return (
    <div className="min-h-screen bg-muted/40 p-6 pb-24 text-foreground">
      <h1 className="text-lg font-semibold">How a Rich control shows on each Channel</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        A: native buttons where the platform has them, numbered text on SMS. B: numbered text
        replies everywhere. C: text plus one link into the app for any control. A password entry
        always links out. Type a reply in any chat to see what the Bot gets.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(Object.keys(scenarios) as Scenario[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => pick(s)}
            className={`rounded-full border px-3 py-1 text-sm ${s === scenario ? "bg-foreground text-background" : "bg-background"}`}
          >
            {scenarios[s].label}
          </button>
        ))}
        {scenario === "long" && (
          <button
            type="button"
            className="ml-4 rounded border bg-background px-2 py-1 text-sm"
            onClick={() =>
              void navigate({
                to: ".",
                search: (p) => ({ ...p, text: text === "split" ? ("cut" as const) : undefined }),
                replace: true,
              })
            }
          >
            Past the limit: <b>{text === "split" ? "split into parts" : "cut + link"}</b> (toggle)
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-6">
        {platforms.map((p) => (
          <Chat
            key={`${p}-${variant}-${scenario}-${text}`}
            platform={p}
            bubbles={render(variant, p, scenario, text)}
            reply={replies[p] ?? null}
            onAnswer={(answer, how) => {
              setReplies((r) => ({ ...r, [p]: answer }));
              const t = { channel: p, ...triggerFor(scenario, answer, how) };
              setTrigger(t);
              setLast(`${p}: ${answer}`);
            }}
          />
        ))}
        <div className="w-72 rounded-xl border bg-background p-3 text-xs">
          <div className="mb-2 font-semibold">Trigger the Bot gets</div>
          <pre className="whitespace-pre-wrap">
            {trigger ? JSON.stringify(trigger, null, 2) : "Nothing yet."}
          </pre>
          <div className="mt-4 mb-1 font-semibold">State</div>
          <pre className="whitespace-pre-wrap">
            {JSON.stringify({ variant, scenario, longText: text, limits }, null, 2)}
          </pre>
        </div>
      </div>
      <PrototypeSwitcher ticket="#1039" variants={variants} current={variant} last={last} />
    </div>
  );
}
