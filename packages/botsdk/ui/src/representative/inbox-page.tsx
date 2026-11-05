import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { plainText } from "@botsdk/client/message-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useChatAdapter, useI18n, useOrpc } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useDropHeldMessage,
  useOwnerInbox,
  useRefreshRepresentatives,
  useReplyDrafts,
  useRepresentatives,
  useSendHeldMessage,
  useSetRepresentativeEnabled,
} from "@botsdk/representative/react";
import type { InboxHeldView, ReplyDraftView } from "@botsdk/representative/client";
import { DraftRow } from "./reply-drafts";

type PageItem = {
  id: string;
  urgency: "routine" | "emergency";
  title: string;
  text: string;
  path: string;
};

/** One thing that needs the owner: what the queue lists, and what the detail shows. */
type Item =
  | { key: string; kind: "page"; page: PageItem }
  | { key: string; kind: "draft"; draft: ReplyDraftView }
  | { key: string; kind: "held"; held: InboxHeldView };

const heldRules = ["caps", "quietHours", "channel", "topicAtRelease"] as const;
const isHeldRule = (rule: string): rule is (typeof heldRules)[number] =>
  (heldRules as readonly string[]).includes(rule);

const whoOf = (name: string | null, to: { channel: string; externalId: string }) =>
  name ?? `${to.channel}: ${to.externalId}`;

const isEmergency = (item: Item) => item.kind === "page" && item.page.urgency === "emergency";

/** The Pages the owner has not acknowledged (the core's), refreshed after one is. */
function usePages() {
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  const options = orpc.pages.list.queryOptions();
  return {
    list: useQuery(options),
    refresh: () => queryClient.invalidateQueries({ queryKey: options.queryKey }),
  };
}

function PageDetail({ page, onAnswered }: { page: PageItem; onAnswered: () => unknown }) {
  const { t } = useI18n();
  const orpc = useOrpc();
  const acknowledge = useMutation(
    orpc.pages.acknowledge.mutationOptions({
      onSuccess: onAnswered,
      onError: () => toast.error(t("settings.acknowledgeFailed")),
    }),
  );
  return (
    <div data-inbox-detail="page" className="space-y-2 p-4">
      <h2 className="text-sm font-medium break-words">{page.title}</h2>
      {page.urgency === "emergency" && (
        <p className="text-xs font-medium text-destructive">{t("settings.pageEmergency")}</p>
      )}
      {/* A Page's text is Markdown from whoever raised it: shown as plain text. */}
      <p className="text-sm break-words whitespace-pre-wrap">{plainText(page.text)}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={acknowledge.isPending}
          aria-label={t("settings.acknowledgePage", { title: page.title })}
          onClick={() => acknowledge.mutate({ id: page.id })}
        >
          {t("settings.acknowledge")}
        </Button>
        <a
          href={page.path}
          className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
        >
          {t("representative.inbox.openPage")}
        </a>
      </div>
    </div>
  );
}

function HeldDetail({ held }: { held: InboxHeldView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const after = {
    onSuccess: () => refresh(),
    onError: async (error: unknown) => {
      toast.error(serverErrorText(i18n, error));
      await refresh();
    },
  };
  const send = useSendHeldMessage(after);
  const drop = useDropHeldMessage(after);
  const acting = send.isPending || drop.isPending;
  return (
    <div data-inbox-detail="held" className="space-y-2 p-4">
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{t("representative.drafts.to", { who: whoOf(held.customerName, held) })}</span>
        <span>{t("representative.inbox.from", { name: held.representativeName })}</span>
        <span>
          {isHeldRule(held.rule)
            ? t(`representative.inbox.heldRule.${held.rule}`)
            : t("representative.inbox.heldBy", { rule: held.rule })}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{t("representative.inbox.heldIntro")}</p>
      {/* The Model wrote it: React shows it as text, never as markup. */}
      <p className="text-sm break-words whitespace-pre-wrap">{held.text}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={acting} onClick={() => send.mutate({ id: held.id })}>
          {t("representative.inbox.send")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={acting}
          onClick={() => drop.mutate({ id: held.id })}
        >
          {t("representative.inbox.drop")}
        </Button>
      </div>
    </div>
  );
}

function SwitchRow({
  id,
  name,
  enabled,
  hasRelease,
}: {
  id: string;
  name: string;
  enabled: boolean;
  hasRelease: boolean;
}) {
  const i18n = useI18n();
  const refresh = useRefreshRepresentatives();
  const setEnabled = useSetRepresentativeEnabled({
    onSuccess: refresh,
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <li data-inbox-representative={id} className="flex items-center gap-2 px-4 py-2 text-sm">
      <Checkbox
        id={`inbox-enabled-${id}`}
        checked={enabled}
        disabled={setEnabled.isPending || (!enabled && !hasRelease)}
        onCheckedChange={(next) => setEnabled.mutate({ id, enabled: next })}
      />
      <Label htmlFor={`inbox-enabled-${id}`} className="min-w-0 flex-1 break-words">
        {i18n.t("representative.inbox.switchOf", { name })}
      </Label>
      <span className="text-xs text-muted-foreground">
        {i18n.t(enabled ? "representative.on" : "representative.off")}
      </span>
    </li>
  );
}

/**
 * The owner's inbox (ticket #1313): one queue across all their Representatives of what needs them,
 * emergencies first, then drafts, held messages and the other Pages, with the chosen one in full
 * beside it. Below are each Representative's on/off and the threads running without the owner.
 */
export function InboxPage() {
  const { t } = useI18n();
  const { Link } = useChatAdapter();
  const pages = usePages();
  const drafts = useReplyDrafts();
  const inbox = useOwnerInbox();
  const representatives = useRepresentatives();
  const [chosen, setChosen] = useState<string | null>(null);

  const pageItems = (pages.list.data ?? []).map((page): Item => ({
    key: `page:${page.id}`,
    kind: "page",
    page,
  }));
  const items: Item[] = [
    ...pageItems.filter(isEmergency),
    ...(drafts.data ?? []).map((draft): Item => ({
      key: `draft:${draft.id}`,
      kind: "draft",
      draft,
    })),
    ...(inbox.data?.held ?? []).map((held): Item => ({
      key: `held:${held.id}`,
      kind: "held",
      held,
    })),
    ...pageItems.filter((item) => !isEmergency(item)),
  ];
  const current = items.find((item) => item.key === chosen);

  const label = (item: Item) => {
    if (item.kind === "page") return item.page.title;
    if (item.kind === "draft") return whoOf(item.draft.customerName, item.draft.to);
    return whoOf(item.held.customerName, item.held);
  };
  const badge = (item: Item) => {
    if (item.kind === "page") {
      return t(isEmergency(item) ? "representative.inbox.emergency" : "representative.inbox.page");
    }
    return t(item.kind === "draft" ? "representative.inbox.draft" : "representative.inbox.held");
  };
  const preview = (item: Item) => {
    if (item.kind === "page") return plainText(item.page.text);
    return item.kind === "draft" ? item.draft.text : item.held.text;
  };

  return (
    <main data-inbox className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{t("representative.inbox.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("representative.inbox.intro")}</p>
      </div>
      <section className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-2">
          <h2 className="text-sm font-medium">{t("representative.inbox.queue")}</h2>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("representative.inbox.empty")}</p>
          ) : (
            <ul
              aria-label={t("representative.inbox.queue")}
              className="divide-y overflow-hidden rounded-xl border"
            >
              {items.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    data-inbox-item={item.key}
                    aria-pressed={item.key === current?.key}
                    className="block w-full space-y-0.5 px-4 py-2 text-left text-sm hover:bg-muted aria-pressed:bg-muted"
                    onClick={() => setChosen(item.key)}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={
                          isEmergency(item)
                            ? "text-xs font-medium text-destructive"
                            : "text-xs text-muted-foreground"
                        }
                      >
                        {badge(item)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{label(item)}</span>
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {preview(item)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(inbox.data?.truncated.held || inbox.data?.truncated.drafts) && (
            <p className="text-xs text-muted-foreground">
              {t("representative.inbox.queueTruncated")}
            </p>
          )}
        </div>
        <div className="rounded-xl border" data-inbox-detail-pane>
          {current === undefined ? (
            <p className="p-4 text-sm text-muted-foreground">{t("representative.inbox.choose")}</p>
          ) : current.kind === "page" ? (
            <PageDetail key={current.key} page={current.page} onAnswered={pages.refresh} />
          ) : current.kind === "held" ? (
            <HeldDetail key={current.key} held={current.held} />
          ) : (
            <ul>
              <DraftRow key={current.key} draft={current.draft} />
            </ul>
          )}
        </div>
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("representative.inbox.representatives")}</h2>
        <ul className="divide-y overflow-hidden rounded-xl border">
          {representatives.data?.map((representative) => (
            <SwitchRow
              key={representative.id}
              id={representative.id}
              name={representative.name}
              enabled={representative.enabled}
              hasRelease={representative.liveReleaseNumber !== null}
            />
          ))}
        </ul>
      </section>
      <section data-inbox-running className="space-y-2">
        <h2 className="text-sm font-medium">{t("representative.inbox.running")}</h2>
        {!inbox.data ? null : inbox.data.running.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("representative.inbox.runningNone")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border">
            {inbox.data.running.map((thread) => (
              <li
                key={thread.id}
                data-inbox-running-thread={thread.id}
                className="flex flex-wrap items-center gap-x-3 px-4 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  {whoOf(thread.customer.name, thread.lastHeard)}
                </span>
                <span className="text-xs text-muted-foreground">{thread.representativeName}</span>
                {thread.waitingOn && (
                  <span className="text-xs text-muted-foreground">
                    {t(`representative.threadWaiting.${thread.waitingOn}`)}
                  </span>
                )}
                <Link
                  page={{ to: "representatives", id: thread.representativeId }}
                  className="text-xs underline"
                >
                  {t("representative.inbox.openThreads")}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {inbox.data?.truncated.running && (
          <p className="text-xs text-muted-foreground">
            {t("representative.inbox.runningTruncated")}
          </p>
        )}
      </section>
    </main>
  );
}
