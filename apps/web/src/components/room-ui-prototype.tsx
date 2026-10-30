/*
 * PROTOTYPE for #1054, throwaway, never merge.
 * Plan: three structurally different Room UIs (A group chat, B roster rail, C handoff threads),
 * switchable via `?variant=A|B|C`, on in-memory stub data; real Bot names from orpc.bots.list.
 * Nothing here calls a mutation or changes anything real.
 */
import { BotAvatar } from "@botsdk/ui/bot/bot-avatar";
import { botColour } from "@botsdk/ui/bot/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CrownIcon,
  EllipsisIcon,
  HandIcon,
  ListTodoIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SendIcon,
  SettingsIcon,
  SquareIcon,
  Trash2Icon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { orpc } from "@/utils/orpc";

// ---------------------------------------------------------------------------------------------
// Stub state
// ---------------------------------------------------------------------------------------------

const HOP_LIMIT = 3;
const FALLBACK = ["Scout", "Writer", "Ops"];

type Status = "working" | "queued" | "idle";
type Msg = {
  id: string;
  /** The user Message that started this chain (variant C groups by it). */
  chain: string;
  /** "you" or a Bot name. */
  author: string;
  text: string;
  /** Who this Message woke: the routed-to Bots for a user Message, the handoff for a Bot's. */
  to?: string[];
  /** Bot-to-Bot hops so far in the chain when this Message was written. */
  hop?: number;
  kind?: "text" | "approval" | "hop-limit" | "stopped" | "system";
  skipped?: string[];
  approval?: "pending" | "approved" | "denied";
  /** For a user Message: the Bots it interrupted, and the paused ones it reached. */
  interrupted?: string[];
  pausedTargets?: string[];
};
type Room = {
  id: string;
  name: string;
  members: string[];
  lead: string;
  status: Record<string, Status>;
  messages: Msg[];
};

let seq = 0;
const nextId = () => `m${++seq}`;

function seedRooms(bots: string[]): Room[] {
  const [a, b, c] = bots as [string, string, string];
  return [
    {
      id: "r1",
      name: "Launch plan",
      members: [a, b, c],
      lead: a,
      status: { [a]: "working", [b]: "idle", [c]: "queued" },
      messages: [
        { id: "s1", chain: "s1", author: "you", text: "Plan the launch post for Friday.", to: [a] },
        {
          id: "s2",
          chain: "s1",
          author: a,
          text: `Outline done: hook, three features, call to action. @${b} can you write the copy?`,
          to: [b],
          hop: 1,
        },
        {
          id: "s3",
          chain: "s1",
          author: b,
          text: `Draft is in launch.md (380 words). @${c} please schedule it for Friday 09:00.`,
          to: [c],
          hop: 2,
        },
        {
          id: "s4",
          chain: "s1",
          author: c,
          text: `Scheduled for Fri 09:00. @${a} can you double-check the links first?`,
          to: [a],
          hop: 3,
        },
        {
          id: "s5",
          chain: "s1",
          author: a,
          text: `Two links were stale, fixed. @${b} the headline could be punchier.`,
          hop: 3,
        },
        { id: "s6", chain: "s1", author: "system", kind: "hop-limit", text: "", skipped: [b] },
        {
          id: "s7",
          chain: "s7",
          author: "you",
          text: `@${c} send the newsletter to the beta list too.`,
          to: [c],
        },
        {
          id: "s8",
          chain: "s7",
          author: c,
          kind: "approval",
          approval: "pending",
          text: "Send “Launch week” to 312 recipients on the beta list?",
        },
      ],
    },
    {
      id: "r2",
      name: "Inbox triage",
      members: [a],
      lead: a,
      status: { [a]: "idle" },
      messages: [
        { id: "t1", chain: "t1", author: "you", text: "Sort today's inbox.", to: [a] },
        { id: "t2", chain: "t1", author: a, text: "Done: 4 need you, 19 archived." },
        { id: "t3", chain: "t3", author: "system", kind: "system", text: "Mailer was deleted." },
      ],
    },
  ];
}

function useRoomState(bots: string[]) {
  const [rooms, setRooms] = useState(() => seedRooms(bots));
  const [roomId, setRoomId] = useState("r1");
  const [paused, setPaused] = useState<string[]>(() => (bots[1] ? [bots[1]] : []));
  const [log, setLog] = useState<string[]>([]);
  const note = (entry: string) => setLog((prev) => [entry, ...prev].slice(0, 5));
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0];

  const patch = (id: string, fn: (r: Room) => Room) =>
    setRooms((prev) => prev.map((r) => (r.id === id ? fn(r) : r)));
  const append = (r: Room, ...msgs: Msg[]) => ({ ...r, messages: [...r.messages, ...msgs] });
  const statusOf = (r: Room, bot: string): Status | "paused" =>
    paused.includes(bot) ? "paused" : (r.status[bot] ?? "idle");

  return {
    bots,
    rooms,
    room,
    log,
    paused,
    statusOf: (bot: string) => (room ? statusOf(room, bot) : "idle"),
    selectRoom: setRoomId,
    /** Waiting-for-you: the last hop-limit note with no user Message after it. */
    waiting: (): Msg | undefined => {
      if (!room) return undefined;
      for (let i = room.messages.length - 1; i >= 0; i--) {
        const m = room.messages[i]!;
        if (m.author === "you") return undefined;
        if (m.kind === "hop-limit") return m;
      }
      return undefined;
    },
    send: (text: string) => {
      if (!room || !text.trim()) return;
      const mentioned = room.members.filter((m) => text.includes(`@${m}`));
      const targets = mentioned.length ? mentioned : [room.lead];
      const interrupted = targets.filter((t) => statusOf(room, t) === "working");
      const pausedTargets = targets.filter((t) => paused.includes(t));
      const live = targets.filter((t) => !paused.includes(t));
      const id = nextId();
      patch(room.id, (r) => ({
        ...append(r, {
          id,
          chain: id,
          author: "you",
          text,
          to: targets,
          interrupted,
          pausedTargets,
        }),
        status: { ...r.status, ...Object.fromEntries(live.map((t) => [t, "working" as const])) },
      }));
      note(`Sent → ${targets.map((t) => `@${t}`).join(", ")}${mentioned.length ? "" : " (lead)"}`);
      live.forEach((bot, i) =>
        setTimeout(
          () =>
            patch(room.id, (r) =>
              r.status[bot] === "working"
                ? {
                    ...append(r, {
                      id: nextId(),
                      chain: id,
                      author: bot,
                      text: `(stub reply) On it: “${text.slice(0, 60)}”.`,
                      hop: 0,
                    }),
                    status: { ...r.status, [bot]: "idle" },
                  }
                : r,
            ),
          1800 + i * 900,
        ),
      );
    },
    stop: () => {
      if (!room) return;
      const running = room.members.filter((m) => room.status[m] === "working");
      if (!running.length) return;
      patch(room.id, (r) => ({
        ...append(r, {
          id: nextId(),
          chain: r.messages.at(-1)?.chain ?? "x",
          author: "system",
          kind: "stopped",
          text: `Stopped ${running.map((m) => `@${m}`).join(", ")}`,
        }),
        status: { ...r.status, ...Object.fromEntries(running.map((m) => [m, "idle" as const])) },
      }));
      note(`Stop: ended ${running.length} Turn(s)`);
    },
    answer: (msgId: string, approval: "approved" | "denied") => {
      if (!room) return;
      patch(room.id, (r) => ({
        ...r,
        messages: r.messages.map((m) => (m.id === msgId ? { ...m, approval } : m)),
      }));
      note(`Approval ${approval}`);
    },
    togglePause: (bot: string) => {
      setPaused((prev) => (prev.includes(bot) ? prev.filter((b) => b !== bot) : [...prev, bot]));
      note(`${paused.includes(bot) ? "Resumed" : "Paused"} ${bot}`);
    },
    reset: (bot: string) => note(`Reset ${bot} (its own memory and Conversation)`),
    createRoom: (name: string, members: string[]) => {
      const id = `r${Date.now()}`;
      setRooms((prev) => [
        ...prev,
        {
          id,
          name,
          members,
          lead: members[0]!,
          status: Object.fromEntries(members.map((m) => [m, "idle" as const])),
          messages: [],
        },
      ]);
      setRoomId(id);
      note(`Created Room "${name}" (lead ${members[0]})`);
    },
    rename: (name: string) => {
      if (!room) return;
      patch(room.id, (r) => ({ ...r, name }));
      note(`Renamed to "${name}"`);
    },
    setLead: (bot: string) => {
      if (!room) return;
      patch(room.id, (r) => ({ ...r, lead: bot }));
      note(`Lead is now ${bot}`);
    },
    addMember: (bot: string) => {
      if (!room) return;
      patch(room.id, (r) => ({
        ...r,
        members: [...r.members, bot],
        status: { ...r.status, [bot]: "idle" },
      }));
      note(`Added ${bot}`);
    },
    removeMember: (bot: string) => {
      if (!room) return;
      if (room.members.length <= 2) {
        note(`Refused: a Room needs 2 Bots`);
        return;
      }
      patch(room.id, (r) => {
        const members = r.members.filter((m) => m !== bot);
        return { ...r, members, lead: r.lead === bot ? members[0]! : r.lead };
      });
      note(`Removed ${bot}`);
    },
    deleteRoom: () => {
      if (!room) return;
      setRooms((prev) => prev.filter((r) => r.id !== room.id));
      setRoomId(rooms.find((r) => r.id !== room.id)?.id ?? "");
      note(`Deleted Room "${room.name}"`);
    },
  };
}
type S = ReturnType<typeof useRoomState>;

// ---------------------------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------------------------

const statusDot: Record<Status | "paused", string> = {
  working: "bg-emerald-500 animate-pulse",
  queued: "bg-sky-500",
  idle: "bg-muted-foreground/40",
  paused: "bg-amber-500",
};

function StatusLabel({ status }: { status: Status | "paused" }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", statusDot[status])} />
      {status}
    </span>
  );
}

function YouAvatar({ size = 32 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-foreground font-semibold text-background"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      You
    </span>
  );
}

function stubTasks(bot: string, status: Status | "paused") {
  return {
    progress: status === "working" ? [`Turn in this Room`, "Helper: check links"] : [],
    scheduled: [
      ...(status === "queued" ? [`Queued Message in this Room`] : []),
      `${bot}: Morning brief (Routine, weekdays 08:00)`,
    ],
    done: ["Drafted the outline", "Check-in fired: invoice"],
  };
}

/** The existing per-Bot "Tasks N" header popover, stubbed. */
function TasksPopover({ s, bot, compact }: { s: S; bot: string; compact?: boolean }) {
  const t = stubTasks(bot, s.statusOf(bot));
  const count = t.progress.length + t.scheduled.length;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="outline" size={compact ? "xs" : "sm"} />}
        aria-label={`${bot} Tasks`}
      >
        <ListTodoIcon /> Tasks {count}
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <p className="text-sm font-medium">{bot}: Tasks</p>
        {(
          [
            ["In progress", t.progress],
            ["Scheduled", t.scheduled],
            ["Done", t.done],
          ] as const
        ).map(([label, items]) => (
          <div key={label} className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase">{label}</p>
            {items.length ? (
              items.map((item) => (
                <p key={item} className="rounded bg-muted px-2 py-1 text-xs">
                  {item}
                </p>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">Nothing</p>
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** The per-Bot "⋯" menu: pause/resume and reset, as on the Bot's own page. */
function BotMenu({ s, bot }: { s: S; bot: string }) {
  const isPaused = s.paused.includes(bot);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={`${bot} menu`} />}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => s.togglePause(bot)}>
          {isPaused ? <PlayIcon /> : <PauseIcon />}
          {isPaused ? `Resume ${bot}` : `Pause ${bot}`}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => s.reset(bot)}>
          <RotateCcwIcon /> Reset {bot}…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => s.removeMember(bot)}>
          <XIcon /> Remove from Room
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Rooms block that would sit under the Bots list in the real sidebar. */
function RoomsNav({ s }: { s: S }) {
  const [creating, setCreating] = useState(false);
  return (
    <nav className="flex w-56 shrink-0 flex-col border-r bg-muted/20">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Rooms
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="New Room"
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
        </Button>
      </div>
      <p className="px-3 pb-2 text-[11px] text-muted-foreground">
        (stub: would sit under the Bots list in the sidebar)
      </p>
      <ul className="flex-1 overflow-y-auto">
        {s.rooms.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => s.selectRoom(r.id)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted",
                r.id === s.room?.id && "bg-muted",
              )}
            >
              <span className="relative flex h-7 w-9 shrink-0">
                {r.members.slice(0, 2).map((m, i) => (
                  <span key={m} className="absolute" style={{ left: i * 10, top: i * 4 }}>
                    <BotAvatar name={m} size={22} />
                  </span>
                ))}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{r.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {r.members.length < 2 ? (
                    <span className="text-amber-600">Only 1 Bot left</span>
                  ) : r.members.some((m) => r.status[m] === "working") ? (
                    "working…"
                  ) : (
                    `${r.members.length} Bots`
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <NewRoomDialog s={s} open={creating} onOpenChange={setCreating} />
    </nav>
  );
}

function NewRoomDialog({
  s,
  open,
  onOpenChange,
}: {
  s: S;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (bot: string) =>
    setPicked((prev) => (prev.includes(bot) ? prev.filter((b) => b !== bot) : [...prev, bot]));
  const ok = name.trim() && picked.length >= 2;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Room</DialogTitle>
          <DialogDescription>
            Name it and pick 2 or more Bots. The first you pick leads: it answers Messages that
            mention no one.
          </DialogDescription>
        </DialogHeader>
        <Input placeholder="Room name" value={name} onChange={(e) => setName(e.target.value)} />
        <ul className="space-y-1">
          {s.bots.map((bot) => {
            const index = picked.indexOf(bot);
            return (
              <li key={bot}>
                <button
                  type="button"
                  onClick={() => toggle(bot)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left",
                    index >= 0 ? "border-primary bg-primary/5" : "hover:bg-muted",
                  )}
                >
                  <BotAvatar name={bot} size={26} />
                  <span className="flex-1 text-sm">{bot}</span>
                  {index === 0 && (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                      <CrownIcon className="size-3" /> lead
                    </span>
                  )}
                  {index > 0 && <span className="text-xs text-muted-foreground">#{index + 1}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!ok}
            onClick={() => {
              s.createRoom(name.trim(), picked);
              setName("");
              setPicked([]);
              onOpenChange(false);
            }}
          >
            Create Room
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Room settings: rename, members with lead, add/remove (refused at 2), delete. */
function RoomSettingsBody({ s, onDone }: { s: S; onDone: () => void }) {
  const room = s.room;
  const [name, setName] = useState(room?.name ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!room) return null;
  const others = s.bots.filter((b) => !room.members.includes(b));
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Name</p>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <Button variant="outline" disabled={!name.trim()} onClick={() => s.rename(name.trim())}>
            Rename
          </Button>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Members ({room.members.length}) · lead answers un-mentioned Messages
        </p>
        <ul className="space-y-1">
          {room.members.map((m) => (
            <li key={m} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
              <BotAvatar name={m} size={24} />
              <span className="flex-1 text-sm">{m}</span>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="radio"
                  name="lead"
                  checked={room.lead === m}
                  onChange={() => s.setLead(m)}
                />
                lead
              </label>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${m}`}
                disabled={room.members.length <= 2}
                title={room.members.length <= 2 ? "A Room needs at least 2 Bots" : undefined}
                onClick={() => s.removeMember(m)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
        {room.members.length <= 2 && (
          <p className="text-xs text-muted-foreground">
            A Room needs at least 2 Bots, so removing is off.
          </p>
        )}
      </div>
      {others.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Add a Bot</p>
          <div className="flex flex-wrap gap-1.5">
            {others.map((b) => (
              <Button key={b} variant="outline" size="xs" onClick={() => s.addMember(b)}>
                <PlusIcon /> {b}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="border-t pt-4">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs">Delete “{room.name}” and its Messages?</span>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                s.deleteRoom();
                onDone();
              }}
            >
              Delete
            </Button>
          </div>
        ) : (
          <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2Icon /> Delete Room
          </Button>
        )}
      </div>
    </div>
  );
}

function RoomSettingsDialog({
  s,
  open,
  onOpenChange,
}: {
  s: S;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Room settings</DialogTitle>
        </DialogHeader>
        {open && <RoomSettingsBody s={s} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** A Room left with 1 Bot: warning, and only Add Bot / Delete Room. */
function SoloWarning({ s }: { s: S }) {
  const room = s.room;
  if (!room || room.members.length >= 2) return null;
  const others = s.bots.filter((b) => !room.members.includes(b));
  return (
    <div className="m-4 space-y-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangleIcon className="size-4 text-amber-600" /> This Room has only one Bot left
      </p>
      <p className="text-xs text-muted-foreground">
        A Bot in it was deleted. Add a Bot to keep talking here, or delete the Room. Its history
        stays readable.
      </p>
      <div className="flex flex-wrap gap-2">
        {others.map((b) => (
          <Button key={b} size="sm" variant="outline" onClick={() => s.addMember(b)}>
            <PlusIcon /> Add {b}
          </Button>
        ))}
        <Button size="sm" variant="destructive" onClick={s.deleteRoom}>
          <Trash2Icon /> Delete Room
        </Button>
      </div>
    </div>
  );
}

/** Message body text with @mentions highlighted in the Bot's colour. */
function MentionText({ text, members }: { text: string; members: string[] }) {
  const names = [...members].sort((a, b) => b.length - a.length);
  const parts: Array<string | { bot: string }> = [];
  let rest = text;
  while (rest) {
    const hits = names
      .map((n) => ({ n, i: rest.indexOf(`@${n}`) }))
      .filter((h) => h.i >= 0)
      .sort((a, b) => a.i - b.i);
    const hit = hits[0];
    if (!hit) {
      parts.push(rest);
      break;
    }
    if (hit.i > 0) parts.push(rest.slice(0, hit.i));
    parts.push({ bot: hit.n });
    rest = rest.slice(hit.i + hit.n.length + 1);
  }
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <span key={i} className="rounded px-0.5 font-medium" style={{ color: botColour(p.bot) }}>
            @{p.bot}
          </span>
        ),
      )}
    </span>
  );
}

function ApprovalCard({ s, m }: { s: S; m: Msg }) {
  return (
    <div className="mt-1 max-w-md space-y-2 rounded-lg border bg-background p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <HandIcon className="size-3.5" /> {m.author} asks for approval
      </p>
      <p className="text-sm">{m.text}</p>
      {m.approval === "pending" ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => s.answer(m.id, "approved")}>
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => s.answer(m.id, "denied")}>
            Deny
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">You {m.approval} this.</p>
      )}
    </div>
  );
}

function HopNote({ m, active }: { m: Msg; active: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed px-3 py-2 text-xs",
        active ? "border-amber-500 bg-amber-500/10" : "text-muted-foreground",
      )}
    >
      <span className="font-medium">
        {active ? "Waiting for you" : "Hop limit reached"} · {HOP_LIMIT}/{HOP_LIMIT} hops
      </span>
      {" — "}didn't wake {m.skipped?.map((b) => `@${b}`).join(", ")}. Reply to carry on.
    </div>
  );
}

/** Routing line under a user Message: who it went to, and who it interrupted or found paused. */
function RoutedTo({ m, lead }: { m: Msg; lead: string }) {
  if (!m.to?.length) return null;
  const toLead = m.to.length === 1 && m.to[0] === lead && !m.text.includes(`@${lead}`);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <ArrowRightIcon className="size-3" />
      {m.to.map((t) => (
        <span
          key={t}
          className="rounded-full px-1.5 py-0.5 font-medium text-white"
          style={{ background: botColour(t) }}
        >
          {t}
        </span>
      ))}
      {toLead && <span>(lead, no mention)</span>}
      {m.interrupted?.length ? <span>· interrupted {m.interrupted.join(", ")}</span> : null}
      {m.pausedTargets?.length ? (
        <span className="text-amber-600">· {m.pausedTargets.join(", ")} paused, won't answer</span>
      ) : null}
    </div>
  );
}

/** Composer with `@` autocomplete over the Room's members and the Room-wide Stop. */
function Composer({ s, above }: { s: S; above?: ReactNode }) {
  const [value, setValue] = useState("");
  const room = s.room;
  const disabled = !room || room.members.length < 2;
  const match = /@([^@\n]*)$/.exec(value);
  const query = match?.[1]?.toLowerCase() ?? "";
  const suggestions =
    match && room
      ? room.members.filter(
          (m) => m.toLowerCase().startsWith(query) && m.toLowerCase() !== query.trimEnd(),
        )
      : [];
  const pick = (bot: string) => setValue(`${value.slice(0, match!.index)}@${bot} `);
  const running = room?.members.filter((m) => room.status[m] === "working") ?? [];
  const submit = () => {
    s.send(value);
    setValue("");
  };
  return (
    <div className="border-t p-3">
      {above}
      <div className="relative">
        {suggestions.length > 0 && (
          <ul className="absolute bottom-full left-0 z-10 mb-1 w-64 rounded-md border bg-popover p-1 shadow-md">
            {suggestions.map((m, i) => (
              <li key={m}>
                <button
                  type="button"
                  onClick={() => pick(m)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted",
                    i === 0 && "bg-muted",
                  )}
                >
                  <BotAvatar name={m} size={20} /> {m}
                  {room?.lead === m && <CrownIcon className="ml-auto size-3 text-amber-600" />}
                  {s.paused.includes(m) && <span className="text-xs text-amber-600">paused</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            disabled={disabled}
            value={value}
            rows={2}
            placeholder={
              disabled
                ? "Add a Bot to keep talking"
                : `Message the Room. No @mention → ${room?.lead} (lead)`
            }
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (suggestions[0]) pick(suggestions[0]);
                else submit();
              }
            }}
          />
          <div className="flex flex-col gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={!running.length}
              onClick={s.stop}
              title="Ends every running Turn in the Room"
            >
              <SquareIcon /> Stop{running.length ? ` (${running.length})` : ""}
            </Button>
            <Button size="sm" disabled={disabled || !value.trim()} onClick={submit}>
              <SendIcon /> Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [dep]);
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Variant A: Group chat
// ---------------------------------------------------------------------------------------------

function MemberPopover({ s, bot }: { s: S; bot: string }) {
  const status = s.statusOf(bot);
  const lead = s.room?.lead === bot;
  return (
    <Popover>
      <PopoverTrigger
        className="relative -ml-2 rounded-full ring-2 ring-background first:ml-0"
        aria-label={bot}
      >
        <BotAvatar name={bot} size={30} />
        {lead && (
          <CrownIcon className="absolute -top-2 left-1/2 size-3.5 -translate-x-1/2 fill-amber-400 text-amber-600" />
        )}
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
            statusDot[status],
          )}
        />
      </PopoverTrigger>
      <PopoverContent className="w-64" align="end">
        <div className="flex items-center gap-2">
          <BotAvatar name={bot} size={28} />
          <div className="flex-1">
            <p className="text-sm font-medium">
              {bot} {lead && <span className="text-xs text-amber-600">· lead</span>}
            </p>
            <StatusLabel status={status} />
          </div>
          <BotMenu s={s} bot={bot} />
        </div>
        <TasksPopover s={s} bot={bot} />
      </PopoverContent>
    </Popover>
  );
}

function VariantA({ s }: { s: S }) {
  const [settings, setSettings] = useState(false);
  const room = s.room;
  const scroll = useAutoScroll(room?.messages.length);
  const waiting = s.waiting();
  if (!room) return <NoRoom />;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2.5">
        <UsersIcon className="size-4 text-muted-foreground" />
        <h1 className="flex-1 truncate font-semibold">{room.name}</h1>
        <div className="flex items-center pt-1">
          {room.members.map((m) => (
            <MemberPopover key={m} s={s} bot={m} />
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Room settings"
          onClick={() => setSettings(true)}
        >
          <SettingsIcon />
        </Button>
      </header>
      <SoloWarning s={s} />
      <div ref={scroll} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {room.messages.map((m) => {
          if (m.kind === "hop-limit") return <HopNote key={m.id} m={m} active={waiting === m} />;
          if (m.kind === "stopped" || m.kind === "system")
            return (
              <p key={m.id} className="text-center text-xs text-muted-foreground">
                {m.text}
              </p>
            );
          return (
            <div key={m.id} className="flex gap-3">
              {m.author === "you" ? <YouAvatar /> : <BotAvatar name={m.author} size={32} />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {m.author === "you" ? "You" : m.author}
                  {room.lead === m.author && (
                    <CrownIcon className="ml-1 inline size-3 text-amber-600" />
                  )}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">10:42</span>
                </p>
                {m.kind === "approval" ? (
                  <ApprovalCard s={s} m={m} />
                ) : (
                  <p className="text-sm">
                    <MentionText text={m.text} members={room.members} />
                  </p>
                )}
                {m.author === "you" && <RoutedTo m={m} lead={room.lead} />}
              </div>
            </div>
          );
        })}
        <TypingLine s={s} />
      </div>
      <Composer s={s} />
      <RoomSettingsDialog s={s} open={settings} onOpenChange={setSettings} />
    </div>
  );
}

function TypingLine({ s }: { s: S }) {
  const working = s.room?.members.filter((m) => s.statusOf(m) === "working") ?? [];
  if (!working.length) return null;
  return (
    <p className="text-xs text-muted-foreground italic">
      {working.join(" and ")} {working.length > 1 ? "are" : "is"} working…
    </p>
  );
}

function NoRoom() {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      No Room selected. Make one with + in Rooms.
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Variant B: Roster rail
// ---------------------------------------------------------------------------------------------

function RosterRail({ s }: { s: S }) {
  const room = s.room!;
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-muted/20">
      <p className="px-4 pt-3 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Members · {room.members.length}
      </p>
      <ul className="space-y-1 px-2">
        {room.members.map((m) => {
          const status = s.statusOf(m);
          const lead = room.lead === m;
          return (
            <li
              key={m}
              className={cn(
                "space-y-1.5 rounded-md border-l-4 bg-background px-2 py-2",
                status === "paused" && "opacity-60",
              )}
              style={{ borderLeftColor: botColour(m) }}
            >
              <div className="flex items-center gap-2">
                <BotAvatar name={m} size={26} />
                <span className="flex-1 truncate text-sm font-medium">{m}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={lead ? `${m} is lead` : `Make ${m} lead`}
                  title={lead ? "Lead" : "Make lead"}
                  onClick={() => s.setLead(m)}
                >
                  <CrownIcon className={lead ? "fill-amber-400 text-amber-600" : "opacity-30"} />
                </Button>
                <BotMenu s={s} bot={m} />
              </div>
              <div className="flex items-center justify-between pl-8">
                <StatusLabel status={status} />
                <TasksPopover s={s} bot={m} compact />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="px-4 pt-3 text-[11px] text-muted-foreground">
        working = running a Turn · queued = a Message waits for it · paused = won't answer
      </p>
    </aside>
  );
}

function VariantB({ s }: { s: S }) {
  const [settings, setSettings] = useState(false);
  const room = s.room;
  const scroll = useAutoScroll(room?.messages.length);
  const waiting = s.waiting();
  if (!room) return <NoRoom />;
  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <h1 className="flex-1 truncate font-semibold">{room.name}</h1>
          <Button variant="outline" size="sm" onClick={() => setSettings(true)}>
            <SettingsIcon /> Room settings
          </Button>
        </header>
        <SoloWarning s={s} />
        <div ref={scroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {room.messages.map((m) => {
            if (m.kind === "hop-limit")
              return (
                <p key={m.id} className="text-center text-[11px] text-muted-foreground">
                  — hop limit: didn't wake {m.skipped?.map((b) => `@${b}`).join(", ")} —
                </p>
              );
            if (m.kind === "stopped" || m.kind === "system")
              return (
                <p key={m.id} className="text-center text-xs text-muted-foreground">
                  {m.text}
                </p>
              );
            const you = m.author === "you";
            return (
              <div key={m.id} className={cn("flex", you && "justify-end")}>
                <div
                  className={cn(
                    "max-w-[75%] rounded-lg px-3 py-2",
                    you ? "bg-primary text-primary-foreground" : "border-l-4 bg-muted",
                  )}
                  style={you ? undefined : { borderLeftColor: botColour(m.author) }}
                >
                  {!you && (
                    <p className="text-xs font-semibold" style={{ color: botColour(m.author) }}>
                      {m.author}
                      {m.hop ? (
                        <span className="ml-1 font-normal text-muted-foreground">
                          · hop {m.hop}
                        </span>
                      ) : null}
                    </p>
                  )}
                  {m.kind === "approval" ? (
                    <ApprovalCard s={s} m={m} />
                  ) : (
                    <p className="text-sm">
                      {you ? m.text : <MentionText text={m.text} members={room.members} />}
                    </p>
                  )}
                  {you && (
                    <div className="[&_*]:text-primary-foreground/80">
                      <RoutedTo m={m} lead={room.lead} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <Composer
          s={s}
          above={
            waiting && (
              <div className="mb-2 flex items-center gap-2 rounded-md bg-amber-500/15 px-3 py-2 text-xs">
                <AlertTriangleIcon className="size-4 text-amber-600" />
                <span className="flex-1">
                  <b>Waiting for you.</b> The Bots handed off {HOP_LIMIT} times;{" "}
                  {waiting.skipped?.map((b) => `@${b}`).join(", ")} wasn't woken. Your next Message
                  resets the count.
                </span>
              </div>
            )
          }
        />
      </div>
      <RosterRail s={s} />
      <RoomSettingsDialog s={s} open={settings} onOpenChange={setSettings} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Variant C: Handoff threads
// ---------------------------------------------------------------------------------------------

function RelayLine({ chain }: { chain: Msg[] }) {
  const steps: string[] = ["You"];
  for (const m of chain) {
    if (m.author === "you" || m.author === "system") continue;
    if (steps.at(-1) !== m.author) steps.push(m.author);
  }
  const hops = Math.max(0, ...chain.map((m) => m.hop ?? 0));
  const limit = chain.find((m) => m.kind === "hop-limit");
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {steps.map((step, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ArrowRightIcon className="size-3 text-muted-foreground" />}
          <span
            className="rounded-full px-2 py-0.5 font-medium"
            style={step === "You" ? undefined : { background: botColour(step), color: "white" }}
          >
            {step === "You" ? "You" : `@${step}`}
          </span>
        </span>
      ))}
      {limit?.skipped?.map((b) => (
        <span key={b} className="flex items-center gap-1 text-muted-foreground line-through">
          <ArrowRightIcon className="size-3" />@{b}
        </span>
      ))}
      <span
        className={cn(
          "ml-auto rounded px-1.5 py-0.5 tabular-nums",
          hops >= HOP_LIMIT ? "bg-amber-500/20 text-amber-700" : "bg-muted text-muted-foreground",
        )}
      >
        hop {hops}/{HOP_LIMIT}
      </span>
    </div>
  );
}

function SlideOver({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" className="flex-1 bg-black/30" onClick={onClose} />
      <div className="flex w-96 flex-col gap-4 overflow-y-auto border-l bg-background p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">{title}</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

function VariantC({ s }: { s: S }) {
  const [settings, setSettings] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const room = s.room;
  const scroll = useAutoScroll(room?.messages.length);
  const waiting = s.waiting();
  if (!room) return <NoRoom />;
  const chains = new Map<string, Msg[]>();
  for (const m of room.messages) chains.set(m.chain, [...(chains.get(m.chain) ?? []), m]);
  const lastUserChain = [...room.messages].reverse().find((x) => x.author === "you")?.chain;
  const shown = [...chains.entries()].filter(
    ([, msgs]) =>
      filter === "all" || msgs.some((m) => m.author === filter || m.to?.includes(filter)),
  );
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="space-y-2 border-b px-4 pt-3">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 truncate font-semibold">{room.name}</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Room settings"
            onClick={() => setSettings(true)}
          >
            <SettingsIcon />
          </Button>
        </div>
        <div className="flex items-end gap-1 overflow-x-auto">
          {["all", ...room.members].map((tab) => {
            const status = tab === "all" ? null : s.statusOf(tab);
            return (
              <div
                key={tab}
                className={cn(
                  "flex items-center gap-1.5 border-b-2 px-2 pb-2",
                  filter === tab ? "border-foreground" : "border-transparent",
                )}
              >
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-sm"
                  onClick={() => setFilter(tab)}
                >
                  {tab === "all" ? (
                    "All"
                  ) : (
                    <>
                      <span className={cn("size-2 rounded-full", statusDot[status!])} />
                      {tab}
                      {room.lead === tab && <CrownIcon className="size-3 text-amber-600" />}
                      {status === "paused" && (
                        <span className="text-xs text-amber-600">paused</span>
                      )}
                    </>
                  )}
                </button>
                {tab !== "all" && filter === tab && (
                  <>
                    <TasksPopover s={s} bot={tab} compact />
                    <BotMenu s={s} bot={tab} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      </header>
      <SoloWarning s={s} />
      <div ref={scroll} className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted/20 px-4 py-4">
        {shown.map(([chainId, msgs]) => {
          const head = msgs[0]!;
          const rest = head.author === "you" ? msgs.slice(1) : msgs;
          return (
            <section
              key={chainId}
              className="space-y-3 rounded-xl border bg-background p-4 shadow-xs"
            >
              {head.author === "you" && (
                <div className="flex gap-2">
                  <YouAvatar size={26} />
                  <div className="flex-1 text-sm">
                    <MentionText text={head.text} members={room.members} />
                    <RoutedTo m={head} lead={room.lead} />
                  </div>
                </div>
              )}
              {head.author === "you" && <RelayLine chain={msgs} />}
              <ol className="space-y-2 border-l-2 pl-4">
                {rest.map((m) => {
                  if (m.kind === "hop-limit")
                    return <HopNote key={m.id} m={m} active={waiting === m} />;
                  if (m.kind === "stopped" || m.kind === "system")
                    return (
                      <li key={m.id} className="text-xs text-muted-foreground">
                        {m.text}
                      </li>
                    );
                  return (
                    <li key={m.id} className="relative">
                      <span
                        className="absolute top-2 -left-[21px] size-2.5 rounded-full"
                        style={{ background: botColour(m.author) }}
                      />
                      <p className="text-xs font-semibold" style={{ color: botColour(m.author) }}>
                        {m.author}
                        {m.to?.length ? (
                          <span className="ml-1 font-normal text-muted-foreground">
                            hands off to {m.to.map((t) => `@${t}`).join(", ")}
                          </span>
                        ) : null}
                      </p>
                      {m.kind === "approval" ? (
                        <ApprovalCard s={s} m={m} />
                      ) : (
                        <p className="text-sm">
                          <MentionText text={m.text} members={room.members} />
                        </p>
                      )}
                    </li>
                  );
                })}
                {msgs
                  .flatMap((m) => (m.author === "you" ? (m.to ?? []) : []))
                  .filter((b) => s.statusOf(b) === "working" && chainId === lastUserChain)
                  .map((b) => (
                    <li key={b} className="text-xs text-muted-foreground italic">
                      {b} is working…
                    </li>
                  ))}
              </ol>
            </section>
          );
        })}
      </div>
      <Composer s={s} />
      <SlideOver open={settings} onClose={() => setSettings(false)} title="Room settings">
        <RoomSettingsBody s={s} onDone={() => setSettings(false)} />
      </SlideOver>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Switcher and mount
// ---------------------------------------------------------------------------------------------

const variants = { A: "Group chat", B: "Roster rail", C: "Handoff threads" } as const;
export type RoomVariant = keyof typeof variants;

function Switcher({ current, log }: { current: RoomVariant; log: string[] }) {
  const navigate = useNavigate();
  const keys = Object.keys(variants) as RoomVariant[];
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
  if (import.meta.env.PROD) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-1">
      {log[0] && (
        <div className="rounded bg-black/70 px-2 py-0.5 text-xs text-white">Last: {log[0]}</div>
      )}
      <div className="flex items-center gap-2 rounded-full bg-fuchsia-600 px-3 py-1 text-sm text-white shadow-lg">
        <button type="button" aria-label="Previous variant" onClick={() => go(-1)}>
          <ChevronLeftIcon className="size-4" />
        </button>
        PROTOTYPE #1054 · {current} ({variants[current]})
        <button type="button" aria-label="Next variant" onClick={() => go(1)}>
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function Prototype({ variant, bots }: { variant: RoomVariant; bots: string[] }) {
  const s = useRoomState(bots);
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <RoomsNav s={s} />
      {/* key: settings forms and filters start fresh per Room. */}
      <div key={s.room?.id} className="flex min-w-0 flex-1">
        {variant === "A" && <VariantA s={s} />}
        {variant === "B" && <VariantB s={s} />}
        {variant === "C" && <VariantC s={s} />}
      </div>
      <Switcher current={variant} log={s.log} />
    </div>
  );
}

export function RoomUiPrototype({ variant }: { variant: RoomVariant }) {
  const list = useQuery(orpc.bots.list.queryOptions());
  if (list.isPending) return <div className="p-6 text-sm text-muted-foreground">Loading Bots…</div>;
  const real = (list.data ?? []).map((b) => b.name).slice(0, 4);
  const bots = [...real, ...FALLBACK.filter((f) => !real.includes(f))].slice(
    0,
    Math.max(4, real.length),
  );
  return <Prototype variant={variant} bots={bots} />;
}
