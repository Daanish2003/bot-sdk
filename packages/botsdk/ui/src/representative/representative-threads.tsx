import { Button } from "@/components/ui/button";
import { useState } from "react";

import { useI18n } from "@botsdk/react/provider";
import { useThread, useThreads } from "@botsdk/representative/react";
import type { ThreadSummary } from "@botsdk/representative/client";

/** One thread's transcript, oldest first, each message under who wrote it and where it went. */
function Transcript({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const thread = useThread(id);
  if (!thread.data) return null;
  return (
    <ol className="space-y-2 border-t px-4 py-3">
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
            {t(
              message.author === "customer"
                ? "representative.threadCustomer"
                : "representative.threadReply",
            )}{" "}
            · {t("representative.threadVia", { channel: message.channel })} ·{" "}
            {new Date(message.createdAt).toLocaleString(locale)}
          </span>
          <span className="block whitespace-pre-wrap break-words">{message.text}</span>
        </li>
      ))}
    </ol>
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
