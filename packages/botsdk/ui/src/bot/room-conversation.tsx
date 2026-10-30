import { Button } from "@/components/ui/button";
import { CrownIcon, EllipsisIcon, UsersIcon } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import { hopLimit } from "@botsdk/client/bot/mentions";
import { dateFormat } from "@botsdk/react/intl";
import { useI18n } from "@botsdk/react/provider";
import { useBotReviews } from "@botsdk/react/bot/reviews";
import { useRoom, useRoomChoices } from "@botsdk/react/bot/rooms";
import { serverErrorText } from "@botsdk/react/rpc-error";
import { BotAvatar } from "./bot-avatar";
import { ChoiceCard } from "./choice-card";
import { RoomComposer } from "./room-composer";
import { RoomMembers } from "./room-members";
import { ReviewRequest } from "./review-request";
import { OneBotWarning, RoomSettingsDialog } from "./room-settings";

/**
 * A Room (spec #1055): one column of Messages, each with its author's avatar and name ("deleted
 * Bot" once that Bot is gone), its members in the header with their status, and a composer that
 * sends to the Room: to the members it @mentions, or to the lead.
 */
export function RoomConversation({ conversationId }: { conversationId: string }) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const { room, messages, error, send, sending, working, stop } = useRoom(conversationId);
  const choices = useRoomChoices(conversationId);
  const [draft, setDraft] = useState("");
  const [managing, setManaging] = useState(false);

  if (error) {
    return (
      <p className="m-auto p-4 text-sm text-muted-foreground">
        {serverErrorText(i18n, error, "error.roomNotFound")}
      </p>
    );
  }
  if (!room) return null;
  const names = new Map(room.members.map((member) => [member.botId, member]));
  const nameOf = (botId: string) => names.get(botId)?.name ?? t("bots.deletedBot");

  const submit = () => {
    const text = draft.trim();
    if (!text || sending || !room || room.members.length < 2) return;
    setDraft("");
    // A refused send puts its text back in the composer and says why.
    void send(text).catch((refusal) => {
      setDraft(text);
      toast.error(serverErrorText(i18n, refusal));
    });
  };
  const time = dateFormat(locale, { hour: "numeric", minute: "2-digit" });

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <UsersIcon className="size-4 text-muted-foreground" />
        <h1 className="flex-1 truncate font-semibold">{room.name}</h1>
        <RoomMembers conversationId={conversationId} members={room.members} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("bots.roomMenu")}
          onClick={() => setManaging(true)}
        >
          <EllipsisIcon />
        </Button>
      </header>
      {room.members.length < 2 && <OneBotWarning room={room} />}
      <RoomSettingsDialog room={room} open={managing} onOpenChange={setManaging} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="m-auto text-sm text-muted-foreground">{t("bots.noMessages")}</p>
        )}
        {messages.map((message) => {
          if (message.role === "reset") return null;
          const author = message.authorBotId ? names.get(message.authorBotId) : undefined;
          const user = message.role === "user";
          const name = user ? t("bots.you") : (author?.name ?? t("bots.deletedBot"));
          const { handoff } = message;
          // A hop past the limit woke no one: the chain waits for the user (spec #1055).
          const stopped = handoff !== undefined && handoff.hops > hopLimit;
          return (
            <Fragment key={message.id}>
              <div data-room-message data-id={message.id} className="flex gap-3">
                {user || !author ? (
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
                  >
                    {user ? "•" : "?"}
                  </span>
                ) : (
                  <BotAvatar name={author.name} size={32} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    <span data-author>{name}</span>
                    {author?.lead && (
                      <CrownIcon className="ml-1 inline size-3 text-amber-600" aria-hidden />
                    )}
                    <time
                      dateTime={message.createdAt.toISOString()}
                      className="ml-2 text-xs font-normal text-muted-foreground"
                    >
                      {time.format(message.createdAt)}
                    </time>
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{message.text}</p>
                  {message.authorBotId && message.control?.kind === "choice" && (
                    <ChoiceCard
                      card={message.control}
                      onAnswer={(answer) =>
                        choices.answer(message.authorBotId!, message.id, answer)
                      }
                      acting={choices.acting.has(message.id)}
                    />
                  )}
                  {message.authorBotId && message.control?.kind === "review_approval" && (
                    <RoomReview
                      botId={message.authorBotId}
                      reviewId={message.control.reviewId}
                      working={working}
                    />
                  )}
                  {handoff && !stopped && (
                    <p data-relay className="mt-1 text-xs text-muted-foreground">
                      {t("bots.handoffRelay", {
                        to: handoff.to.map((botId) => `@${nameOf(botId)}`).join(", "),
                        hop: handoff.hops,
                        limit: hopLimit,
                      })}
                    </p>
                  )}
                </div>
              </div>
              {stopped && (
                <div
                  role="separator"
                  className="border-y py-1 text-center text-xs text-muted-foreground"
                >
                  {t("bots.handoffStopped", {
                    from: name,
                    to: handoff.to.map(nameOf).join(", "),
                    limit: hopLimit,
                  })}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      <RoomComposer
        members={room.members}
        draft={draft}
        setDraft={setDraft}
        onSend={submit}
        onStop={
          working
            ? () => void stop().catch((refusal) => toast.error(serverErrorText(i18n, refusal)))
            : undefined
        }
        disabled={room.members.length < 2}
      />
    </section>
  );
}

/**
 * The Approval a Bot asked in the Room (spec #1055), under its Message: the Bot's review, answered
 * with the existing allow and deny routes. It shows once the Bot's reviews are read.
 */
function RoomReview({
  botId,
  reviewId,
  working,
}: {
  botId: string;
  reviewId: string;
  working: boolean;
}) {
  const { reviews, acting, allow, deny } = useBotReviews(botId, working);
  const review = reviews.find((found) => found.id === reviewId);
  if (!review) return null;
  return (
    <ReviewRequest review={review} onAllow={allow} onDeny={deny} acting={acting.has(review.id)} />
  );
}
