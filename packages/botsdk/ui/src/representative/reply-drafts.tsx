import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useAddTopic,
  useApproveReplyDraft,
  useEditReplyDraft,
  useRefreshRepresentatives,
  useRejectReplyDraft,
  useRemoveTopic,
  useReplyDrafts,
  useTopics,
} from "@botsdk/representative/react";
import type { ReplyDraftView, TopicView } from "@botsdk/representative/client";
import { ReplySources } from "./reply-sources";

/** What the owner does after answering: refresh, and a refused answer may mean the draft has gone. */
function useAfterAnswer() {
  const i18n = useI18n();
  const refresh = useRefreshRepresentatives();
  return {
    onSuccess: () => refresh(),
    onError: async (error: unknown) => {
      toast.error(serverErrorText(i18n, error));
      await refresh();
    },
  };
}

/** One reply waiting: its words, where they go, and the owner's three answers. */
function DraftRow({ draft }: { draft: ReplyDraftView }) {
  const { t } = useI18n();
  const after = useAfterAnswer();
  const approve = useApproveReplyDraft(after);
  const edit = useEditReplyDraft(after);
  const reject = useRejectReplyDraft(after);
  const [edited, setEdited] = useState<string | null>(null);
  const acting = approve.isPending || edit.isPending || reject.isPending;
  const who = draft.customerName ?? `${draft.to.channel}: ${draft.to.externalId}`;
  return (
    <li data-reply-draft={draft.id} className="space-y-2 p-4">
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{t("representative.drafts.to", { who })}</span>
        <span>
          {draft.topic
            ? t("representative.drafts.topic", { topic: draft.topic })
            : t("representative.drafts.noTopic")}
        </span>
        {!draft.verified && <span>{t("representative.customers.unverified")}</span>}
      </div>
      {edited === null ? (
        <>
          {/* The Model wrote it: React shows it as text, never as markup. */}
          <p className="text-sm whitespace-pre-wrap break-words">{draft.text}</p>
          <ReplySources reply={draft.reply} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={acting} onClick={() => approve.mutate({ id: draft.id })}>
              {t("representative.drafts.approve")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={acting}
              onClick={() => setEdited(draft.text)}
            >
              {t("representative.drafts.edit")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={acting}
              onClick={() => reject.mutate({ id: draft.id })}
            >
              {t("representative.drafts.reject")}
            </Button>
          </div>
        </>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            edit.mutate({ id: draft.id, text: edited });
          }}
        >
          <Textarea
            aria-label={t("representative.drafts.editLabel")}
            value={edited}
            onChange={(event) => setEdited(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={acting || edited.trim() === ""}>
              {t("representative.drafts.sendEdited")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={acting}
              onClick={() => setEdited(null)}
            >
              {t("representative.drafts.cancelEdit")}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function TopicRow({ topic }: { topic: TopicView }) {
  const { t } = useI18n();
  const remove = useRemoveTopic(useAfterAnswer());
  return (
    <li data-topic-name={topic.name} className="flex items-center gap-3 px-4 py-2 text-sm">
      <span className="min-w-0 flex-1 break-words">{topic.name}</span>
      <span className="text-xs text-muted-foreground">{topic.mode}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={remove.isPending}
        aria-label={t("representative.topics.removeOf", { name: topic.name })}
        onClick={() => remove.mutate({ id: topic.id })}
      >
        {t("representative.topics.remove")}
      </Button>
    </li>
  );
}

function TopicList() {
  const { t } = useI18n();
  const topics = useTopics();
  const after = useAfterAnswer();
  const [name, setName] = useState("");
  const add = useAddTopic({
    ...after,
    onSuccess: async () => {
      setName("");
      await after.onSuccess();
    },
  });
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t("representative.topics.title")}</h3>
      <p className="text-sm text-muted-foreground">{t("representative.topics.intro")}</p>
      {topics.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("representative.topics.none")}</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {topics.data?.map((topic) => (
            <TopicRow key={topic.id} topic={topic} />
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate({ name });
        }}
      >
        <Input
          className="w-64"
          aria-label={t("representative.topics.nameLabel")}
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={add.isPending || name.trim() === ""}
        >
          {t("representative.topics.add")}
        </Button>
      </form>
    </div>
  );
}

/**
 * This Representative's replies waiting for the owner, and the owner's topics, which all their
 * Representatives share. The inbox gives these their lasting place.
 */
export function ReplyDrafts({ id }: { id: string }) {
  const { t } = useI18n();
  const drafts = useReplyDrafts();
  const mine = drafts.data?.filter((draft) => draft.representativeId === id) ?? [];
  return (
    <section data-reply-drafts className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-sm font-medium">{t("representative.drafts.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("representative.drafts.intro")}</p>
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("representative.drafts.none")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border">
            {mine.map((draft) => (
              <DraftRow key={draft.id} draft={draft} />
            ))}
          </ul>
        )}
      </div>
      <TopicList />
    </section>
  );
}
