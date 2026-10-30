/*
 * PROTOTYPE, throw away (#1043, "What the Channels section of Bot settings looks like"). Three
 * variants of managing Channel accounts (per Bot) and Linked identities, the link code and the
 * notification routes (per user), mounted in the /bots/$botId header and switchable via
 * `?variant=A|B|C`. Mock state in memory: nothing here calls the server.
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  AlertTriangleIcon,
  CheckIcon,
  MessagesSquareIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { PrototypeSwitcher } from "@/components/prototype-switcher";

const variants = {
  A: "Bot popover + Settings",
  B: "One Channels page",
  C: "Connect wizard",
} as const;
export type ChannelSettingsVariant = keyof typeof variants;

const platforms = ["telegram", "discord", "slack", "matrix", "whatsapp", "sms"] as const;
type Platform = (typeof platforms)[number];
const names: Record<Platform, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
  matrix: "Matrix",
  whatsapp: "WhatsApp",
  sms: "SMS (Telnyx)",
};
const credentialHint: Record<Platform, string> = {
  telegram: "Bot token from @BotFather",
  discord: "Application ID + bot token from the Developer Portal",
  slack: "Bot token (xoxb-) + app-level token (xapp-) for Socket Mode",
  matrix: "Homeserver URL + access token of the Bot's Matrix account",
  whatsapp: "Phone number ID + access token + app secret from Meta",
  sms: "Telnyx API key + phone number",
};

type AccountState = "ok" | "attention";
type State = {
  bots: string[];
  /** Channel accounts, per Bot. */
  accounts: Record<string, Partial<Record<Platform, { handle: string; state: AccountState }>>>;
  /** The user's Linked identities. */
  identities: Partial<Record<Platform, string>>;
  code: string | null;
  urgent: string;
  other: string;
  log: string[];
};

const initial: State = {
  bots: ["Ada", "Scout"],
  accounts: {
    Ada: {
      telegram: { handle: "@ada_bot", state: "ok" },
      slack: { handle: "Ada (acme)", state: "attention" },
    },
    Scout: { telegram: { handle: "@scout_bot", state: "ok" } },
  },
  identities: { telegram: "@daanish" },
  code: null,
  urgent: "default",
  other: "default",
  log: [],
};

function useMock() {
  const [s, set] = useState(initial);
  const act = (what: string, change: (s: State) => Partial<State>) =>
    set((prev) => ({ ...prev, ...change(prev), log: [what, ...prev.log].slice(0, 20) }));
  return {
    s,
    connect: (bot: string, p: Platform) =>
      act(`${bot}: connected ${names[p]}`, (prev) => ({
        accounts: {
          ...prev.accounts,
          [bot]: {
            ...prev.accounts[bot],
            [p]: { handle: `${bot.toLowerCase()}_${p}`, state: "ok" },
          },
        },
      })),
    remove: (bot: string, p: Platform) =>
      act(`${bot}: removed ${names[p]}`, (prev) => {
        const { [p]: _gone, ...rest } = prev.accounts[bot] ?? {};
        return { accounts: { ...prev.accounts, [bot]: rest } };
      }),
    newCode: () =>
      act("link code issued", () => ({
        code: String(Math.floor(100000 + Math.random() * 900000)),
      })),
    linkFrom: (p: Platform) =>
      act(`code arrived on ${names[p]}: linked`, (prev) => ({
        identities: {
          ...prev.identities,
          [p]: p === "sms" || p === "whatsapp" ? "+1 555 0100" : "@daanish",
        },
        code: null,
      })),
    unlink: (p: Platform) =>
      act(`unlinked ${names[p]}`, (prev) => {
        const { [p]: _gone, ...rest } = prev.identities;
        return { identities: rest };
      }),
    route: (which: "urgent" | "other", value: string) =>
      act(`${which} → ${value}`, () => ({ [which]: value })),
  };
}
type Mock = ReturnType<typeof useMock>;

// ---------------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------------

function StateDot({ state }: { state: AccountState }) {
  return state === "ok" ? (
    <CheckIcon className="size-4 text-green-600" />
  ) : (
    <AlertTriangleIcon className="size-4 text-amber-600" />
  );
}

function PasteForm({ platform, onDone }: { platform: Platform; onDone: () => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) onDone();
      }}
    >
      <p className="text-xs text-muted-foreground">{credentialHint[platform]}</p>
      <div className="flex gap-1">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste…"
        />
        <Button type="submit" size="sm">
          Save
        </Button>
      </div>
    </form>
  );
}

function LinkCode({ m, platform }: { m: Mock; platform?: Platform }) {
  const { code } = m.s;
  if (!code)
    return (
      <Button size="sm" variant="outline" onClick={m.newCode}>
        Get a link code
      </Button>
    );
  return (
    <div className="flex flex-col gap-1 rounded border p-2 text-xs">
      <div>
        Send <code className="rounded bg-muted px-1 text-sm font-bold">{code}</code> to any of your
        Bots. Expires in 10 minutes.
      </div>
      <div className="flex flex-wrap gap-2 text-blue-600 underline">
        <span>t.me/ada_bot?start={code}</span>
        <span>wa.me/15550134?text={code}</span>
      </div>
      <div className="flex flex-wrap gap-1 pt-1">
        <span className="text-muted-foreground">Simulate the code arriving on:</span>
        {(platform ? [platform] : platforms).map((p) => (
          <button key={p} type="button" className="underline" onClick={() => m.linkFrom(p)}>
            {names[p]}
          </button>
        ))}
      </div>
    </div>
  );
}

function Routes({ m }: { m: Mock }) {
  const linked = (Object.keys(m.s.identities) as Platform[]).map((p) => names[p]);
  const options = ["default", "in_app", "email", "push", ...linked];
  const select = (which: "urgent" | "other") => (
    <select
      className="rounded border bg-background px-1 py-0.5 text-sm"
      value={m.s[which]}
      onChange={(e) => m.route(which, e.target.value)}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o === "default"
            ? which === "urgent"
              ? "Default (push, else last Channel)"
              : "Default (last Channel)"
            : o}
        </option>
      ))}
    </select>
  );
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-sm">
      <span>Urgent Messages</span>
      {select("urgent")}
      <span>Everything else</span>
      {select("other")}
      <span className="col-span-2 text-xs text-muted-foreground">
        Only Channels you've linked are offered.
      </span>
    </div>
  );
}

function Identities({ m }: { m: Mock }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      {platforms.map((p) => (
        <div key={p} className="flex items-center justify-between">
          <span>{names[p]}</span>
          {m.s.identities[p] ? (
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">{m.s.identities[p]}</span>
              <button
                type="button"
                className="text-xs text-red-600 underline"
                onClick={() => m.unlink(p)}
              >
                Unlink
              </button>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">not linked</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// A: the Bot header's Channels popover for this Bot's accounts; identities and routes in Settings
// ---------------------------------------------------------------------------------------------

function VariantA({ m, bot }: { m: Mock; bot: string }) {
  const [adding, setAdding] = useState<Platform | null>(null);
  const [settings, setSettings] = useState(false);
  const accounts = m.s.accounts[bot] ?? {};
  const attention = Object.values(accounts).some((a) => a?.state === "attention");
  return (
    <>
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" />}>
          <MessagesSquareIcon /> Channels{" "}
          {attention && <AlertTriangleIcon className="text-amber-600" />}
        </PopoverTrigger>
        <PopoverContent align="end" className="flex w-96 flex-col gap-3">
          <p className="text-xs text-muted-foreground">Where {bot} is a contact you can message.</p>
          {platforms.map((p) => {
            const a = accounts[p];
            return (
              <div key={p} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1">
                    {a && <StateDot state={a.state} />} {names[p]}
                    {a && <span className="text-muted-foreground">· {a.handle}</span>}
                  </span>
                  {a ? (
                    <span className="flex gap-1">
                      {a.state === "attention" && (
                        <Button size="xs" variant="outline" onClick={() => setAdding(p)}>
                          Fix
                        </Button>
                      )}
                      <Button size="icon-xs" variant="ghost" onClick={() => m.remove(bot, p)}>
                        <Trash2Icon />
                      </Button>
                    </span>
                  ) : (
                    <Button size="xs" variant="ghost" onClick={() => setAdding(p)}>
                      <PlusIcon /> Add
                    </Button>
                  )}
                </div>
                {a?.state === "attention" && (
                  <p className="text-xs text-amber-700">
                    Slack rejected the token. Paste a new one.
                  </p>
                )}
                {adding === p && (
                  <PasteForm
                    platform={p}
                    onDone={() => {
                      m.connect(bot, p);
                      setAdding(null);
                    }}
                  />
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="self-start text-xs underline"
            onClick={() => setSettings(true)}
          >
            Your linked identities and where Messages go → Settings
          </button>
        </PopoverContent>
      </Popover>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Settings · Notifications</DialogTitle>
            <DialogDescription>
              For all your Bots (the existing Settings page, with two new parts).
            </DialogDescription>
          </DialogHeader>
          <Section title="Linked identities">
            <Identities m={m} />
            <LinkCode m={m} />
          </Section>
          <Section title="Where Messages go">
            <Routes m={m} />
          </Section>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// B: one Channels page, a grid of platforms × (you, each Bot)
// ---------------------------------------------------------------------------------------------

function VariantB({ m }: { m: Mock }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<{ bot: string; p: Platform } | null>(null);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MessagesSquareIcon /> Channels
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Channels</DialogTitle>
            <DialogDescription>
              A page of its own in Settings: every platform, you and each of your Bots in one grid.
            </DialogDescription>
          </DialogHeader>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1">Platform</th>
                <th>You</th>
                {m.s.bots.map((b) => (
                  <th key={b}>{b}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {platforms.map((p) => (
                <tr key={p} className="border-b align-top">
                  <td className="py-2 font-medium">{names[p]}</td>
                  <td className="py-2">
                    {m.s.identities[p] ? (
                      <span className="flex items-center gap-1">
                        {m.s.identities[p]}
                        <button
                          type="button"
                          className="text-xs text-red-600 underline"
                          onClick={() => m.unlink(p)}
                        >
                          Unlink
                        </button>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">not linked</span>
                    )}
                  </td>
                  {m.s.bots.map((b) => {
                    const a = m.s.accounts[b]?.[p];
                    const isAdding = adding?.bot === b && adding.p === p;
                    return (
                      <td key={b} className="py-2">
                        {a ? (
                          <span className="flex items-center gap-1">
                            <StateDot state={a.state} /> {a.handle}
                            <button type="button" onClick={() => m.remove(b, p)}>
                              <Trash2Icon className="size-3" />
                            </button>
                          </span>
                        ) : isAdding ? (
                          <PasteForm
                            platform={p}
                            onDone={() => {
                              m.connect(b, p);
                              setAdding(null);
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="text-xs underline"
                            onClick={() => setAdding({ bot: b, p })}
                          >
                            + Add
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-cols-2 gap-6">
            <Section title="Link yourself">
              <LinkCode m={m} />
            </Section>
            <Section title="Where Messages go">
              <Routes m={m} />
            </Section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// C: a step-by-step "Connect a Channel" wizard that adds the account and links you in one go
// ---------------------------------------------------------------------------------------------

function VariantC({ m, bot }: { m: Mock; bot: string }) {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [step, setStep] = useState(0);
  const accounts = m.s.accounts[bot] ?? {};
  const close = () => {
    setPlatform(null);
    setStep(0);
  };
  const steps = ["Make the bot", "Paste its credentials", "Link yourself", "Where Messages go"];
  return (
    <>
      {(Object.keys(accounts) as Platform[]).map((p) => (
        <span key={p} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
          <StateDot state={accounts[p]!.state} /> {names[p]}
        </span>
      ))}
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" />}>
          <PlusIcon /> Connect a Channel
        </PopoverTrigger>
        <PopoverContent align="end" className="grid w-64 grid-cols-2 gap-1">
          {platforms.map((p) => (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              disabled={!!accounts[p]}
              onClick={() => setPlatform(p)}
            >
              {names[p]}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
      <Dialog open={!!platform} onOpenChange={(o) => !o && close()}>
        {platform && (
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                Connect {bot} to {names[platform]}
              </DialogTitle>
              <DialogDescription>
                Step {step + 1} of 4 · {steps[step]}
              </DialogDescription>
            </DialogHeader>
            <ol className="flex gap-1">
              {steps.map((s, i) => (
                <li
                  key={s}
                  className={cn("h-1 flex-1 rounded", i <= step ? "bg-foreground" : "bg-muted")}
                />
              ))}
            </ol>
            {step === 0 && (
              <div className="text-sm">
                <p>
                  {platform === "telegram"
                    ? "Open @BotFather in Telegram, send /newbot, and give it a name like “Ada”."
                    : `Create the bot in ${names[platform]}'s developer console. It becomes ${bot}'s own contact.`}
                </p>
                <Button className="mt-3" size="sm" onClick={() => setStep(1)}>
                  I've made it
                </Button>
              </div>
            )}
            {step === 1 && (
              <PasteForm
                platform={platform}
                onDone={() => {
                  m.connect(bot, platform);
                  setStep(m.s.identities[platform] ? 3 : 2);
                }}
              />
            )}
            {step === 2 && (
              <div className="flex flex-col gap-2 text-sm">
                <p>
                  Now message {bot} from your own {names[platform]} account so it knows it's you.
                </p>
                <LinkCode m={m} platform={platform} />
                <Button size="sm" disabled={!m.s.identities[platform]} onClick={() => setStep(3)}>
                  {m.s.identities[platform]
                    ? `Linked as ${m.s.identities[platform]}, next`
                    : "Waiting for your message…"}
                </Button>
              </div>
            )}
            {step === 3 && (
              <div className="flex flex-col gap-2">
                <Routes m={m} />
                <Button size="sm" onClick={close}>
                  Done
                </Button>
              </div>
            )}
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------------------------

/** The header part for `variant`, plus the floating switcher and a state readout. */
export function ChannelSettingsPrototype({ variant }: { variant: ChannelSettingsVariant }) {
  const m = useMock();
  const bot = "Ada";
  return (
    <>
      {variant === "A" && <VariantA m={m} bot={bot} />}
      {variant === "B" && <VariantB m={m} />}
      {variant === "C" && <VariantC m={m} bot={bot} />}
      <details className="fixed right-4 bottom-4 z-[60] max-w-xs rounded bg-black/80 p-2 text-xs text-white">
        <summary>Prototype state</summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap">
          {JSON.stringify({ ...m.s, log: undefined }, null, 2)}
        </pre>
      </details>
      <PrototypeSwitcher ticket="#1043" variants={variants} current={variant} last={m.s.log[0]} />
    </>
  );
}
