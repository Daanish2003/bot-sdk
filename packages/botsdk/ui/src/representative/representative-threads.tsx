import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
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
import type { ThreadMessageView, ThreadSummary } from "@botsdk/representative/client";

const authorLabels = {
  customer: "representative.threadCustomer",
  representative: "representative.threadReply",
  owner: "representative.threadOwner",
  note: "representative.threadNote",
  bot: "representative.threadBot",
} as const satisfies Record<ThreadMessageView["author"], string>;

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
function Transcript({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const thread = useThread(id);
  if (!thread.data) return null;
  return (
    <div className="space-y-3 border-t px-4 py-3">
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
        {thread.data.messages.map((message) => (
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
        ))}
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
