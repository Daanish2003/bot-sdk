import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useState } from "react";
import { ReplySources } from "./reply-sources";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useHandBackThread,
  useRefreshRepresentatives,
  useSendThreadMessage,
  useTakeOverThread,
  useThread,
  useThreads,
} from "@botsdk/representative/react";
import {
  callLimitSeconds,
  type ThreadMessageView,
  type ThreadSummary,
} from "@botsdk/representative/client";

const authorLabels = {
  customer: "representative.threadCustomer",
  representative: "representative.threadReply",
  owner: "representative.threadOwner",
  note: "representative.threadNote",
  bot: "representative.threadBot",
  call: "representative.threadCall",
} as const satisfies Record<ThreadMessageView["author"], string>;

/** A running time as 2:14. */
const clockOf = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** How long a live Call has run, ticking each second. */
function useCallClock(startedAt: Date | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt ? clockOf(now - startedAt.getTime()) : "";
}

/**
 * A Call in the thread, the verdict on #1366: its lines between a "Call started" and a "Call ended"
 * divider, which collapse to the one divider with "Show N". The closing divider says how it ended.
 */
function CallGroup({ message }: { message: ThreadMessageView }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(true);
  const { status, startedAt, endedAt, lines } = message.call!;
  const minutes = Math.max(
    1,
    Math.round(((endedAt ?? startedAt).getTime() - startedAt.getTime()) / 60_000),
  );
  const capped =
    endedAt !== null && endedAt.getTime() - startedAt.getTime() >= callLimitSeconds * 1000;
  return (
    <li data-author="call" data-call-group="" className="space-y-1 text-sm">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground"
        onClick={() => setOpen(!open)}
      >
        <span>
          {t("representative.threadCallStarted", {
            time: startedAt.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
          })}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span>
          {open
            ? t("representative.threadCallHide")
            : t("representative.threadCallShow", { count: lines.length })}
        </span>
      </button>
      {open && (
        <>
          <ol className="space-y-1">
            {lines.map((line, index) => (
              // A transcript never changes, so a line's place is its identity.
              <li key={index} data-call-line={line.role} className="space-y-0.5">
                <span className="block text-xs text-muted-foreground">
                  {line.role === "caller"
                    ? t("representative.threadCallByPhone")
                    : t("representative.threadReply")}
                </span>
                <span className="block whitespace-pre-wrap break-words">{line.text}</span>
              </li>
            ))}
          </ol>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <span aria-hidden className="h-px flex-1 bg-border" />
            <span>
              {status === "ended_no_transcript" || lines.length === 0
                ? t("representative.threadCallNoTranscript")
                : capped
                  ? t("representative.threadCallCapped", { minutes })
                  : t("representative.threadCallEnded", { minutes })}
            </span>
          </p>
        </>
      )}
    </li>
  );
}

/** A Call still on the line: it has no entry yet, so only its opening and a running closing divider. */
function LiveCallGroup({ startedAt, clock }: { startedAt: Date; clock: string }) {
  const { t, locale } = useI18n();
  return (
    <li data-call-group="" data-call-live="" className="space-y-1 text-xs text-muted-foreground">
      <p>
        {t("representative.threadCallStarted", {
          time: startedAt.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
        })}
      </p>
      <p>{t("representative.threadCallLive", { clock })}</p>
    </li>
  );
}

/** Take over and Hand back, and while the owner holds the thread, what they write to the Customer. */
function ThreadActions({ thread }: { thread: ThreadSummary }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const [text, setText] = useState("");
  const after = {
    onSuccess: () => refresh(),
    onError: (error: unknown) => toast.error(serverErrorText(i18n, error)),
  };
  const takeOver = useTakeOverThread(after);
  const handBack = useHandBackThread(after);
  const send = useSendThreadMessage({
    ...after,
    onSuccess: () => {
      setText("");
      return refresh();
    },
  });
  if (thread.holder === "closed") return null;
  if (thread.holder === "representative") {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={takeOver.isPending}
        onClick={() => takeOver.mutate({ id: thread.id })}
      >
        {t("representative.threadTakeOver")}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      {!thread.customer.blocked && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            send.mutate({ id: thread.id, text });
          }}
        >
          <Textarea
            aria-label={t("representative.threadMessageLabel")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={send.isPending || text.trim() === ""}>
            {t("representative.threadSend")}
          </Button>
        </form>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={handBack.isPending}
        onClick={() => handBack.mutate({ id: thread.id })}
      >
        {t("representative.threadHandBack")}
      </Button>
    </div>
  );
}

/** One thread's transcript, oldest first, each message under who wrote it and where it went. */
export function Transcript({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const thread = useThread(id);
  const clock = useCallClock(thread.data?.liveCall?.startedAt);
  if (!thread.data) return null;
  const { liveCall } = thread.data;
  return (
    <div className="space-y-3 border-t px-4 py-3">
      {liveCall && (
        <p className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
          <span className="size-2 animate-pulse rounded-full bg-emerald-600" />
          {t("representative.threadCallPill", { clock })}
        </p>
      )}
      <ol className="space-y-2">
        {thread.data.customer.blocked && (
          <li className="text-xs text-muted-foreground">{t("representative.threadBlocked")}</li>
        )}
        <li className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {thread.data.identities.map((identity) => (
            <span key={identity.id} data-verified={identity.verified}>
              {identity.channel}: {identity.externalId} ·{" "}
              {t(
                identity.verified
                  ? "representative.customers.verified"
                  : "representative.customers.unverified",
              )}
            </span>
          ))}
        </li>
        {thread.data.messages.map((message) =>
          message.call ? (
            <CallGroup key={message.id} message={message} />
          ) : (
            <li key={message.id} data-author={message.author} className="space-y-0.5 text-sm">
              <span className="block text-xs text-muted-foreground">
                {t(authorLabels[message.author])} ·{" "}
                {t("representative.threadVia", { channel: message.channel })} ·{" "}
                {!message.verified && <>{t("representative.customers.unverified")} · </>}
                {new Date(message.createdAt).toLocaleString(locale)}
              </span>
              <span className="block whitespace-pre-wrap break-words">{message.text}</span>
              {message.reply && <ReplySources reply={message.reply} />}
            </li>
          ),
        )}
        {liveCall && <LiveCallGroup startedAt={liveCall.startedAt} clock={clock} />}
      </ol>
      <ThreadActions thread={thread.data} />
    </div>
  );
}

function ThreadRow({ thread }: { thread: ThreadSummary }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const who = thread.customer.name ?? `${thread.lastHeard.channel}: ${thread.lastHeard.externalId}`;
  const toggle = t(open ? "representative.threadClose" : "representative.threadOpen");
  return (
    <li data-thread={thread.id} data-waiting-on={thread.waitingOn ?? "none"}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
        <span className="flex-1 space-y-0.5">
          <span className="block font-medium">{who}</span>
          <span className="block text-xs text-muted-foreground">
            {t(`representative.threadHolder.${thread.holder}`)}
            {thread.waitingOn &&
              ` · ${t(`representative.threadWaiting.${thread.waitingOn}`)}`} ·{" "}
            {t("representative.threadMessages", { count: thread.messageCount })} ·{" "}
            {new Date(thread.updatedAt).toLocaleString(locale)}
          </span>
        </span>
        {thread.customer.blocked && (
          <span className="text-xs font-medium">{t("representative.customers.blockedBadge")}</span>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-label={`${toggle} ${who}`}
          onClick={() => setOpen(!open)}
        >
          {toggle}
        </Button>
      </div>
      {open && <Transcript id={thread.id} />}
    </li>
  );
}

/** A Representative's Customer threads: who holds each, who it waits on, and its transcript. */
export function RepresentativeThreads({ id }: { id: string }) {
  const { t } = useI18n();
  const threads = useThreads(id);
  return (
    <section className="space-y-2" aria-label={t("representative.threads")}>
      <h2 className="text-sm font-medium">{t("representative.threads")}</h2>
      <p className="text-xs text-muted-foreground">{t("representative.threadsHelp")}</p>
      {threads.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("representative.noThreads")}</p>
      )}
      <ul className="divide-y overflow-hidden rounded-xl border empty:hidden">
        {threads.data?.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} />
        ))}
      </ul>
    </section>
  );
}
