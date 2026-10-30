import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CrownIcon, EllipsisIcon, SendIcon, UsersIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { toast } from "sonner";

import { dateFormat } from "@botsdk/react/intl";
import { useI18n } from "@botsdk/react/provider";
import { useRoom } from "@botsdk/react/bot/rooms";
import { serverErrorText } from "@botsdk/react/rpc-error";
import { BotAvatar } from "./bot-avatar";
import { OneBotWarning, RoomSettingsDialog } from "./room-settings";

/**
 * A Room (spec #1055): one column of Messages, each with its author's avatar and name ("deleted
 * Bot" once that Bot is gone), and a composer that sends to the Room, where the lead answers.
 */
export function RoomConversation({ conversationId }: { conversationId: string }) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const { room, messages, error, send, sending } = useRoom(conversationId);
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

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending || !room || room.members.length < 2) return;
    setDraft("");
    // A refused send puts its text back in the composer and says why.
    void send(text).catch((refusal) => {
      setDraft(text);
      toast.error(serverErrorText(i18n, refusal));
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };
  const time = dateFormat(locale, { hour: "numeric", minute: "2-digit" });

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <UsersIcon className="size-4 text-muted-foreground" />
        <h1 className="flex-1 truncate font-semibold">{room.name}</h1>
        <div className="flex items-center gap-1">
          {room.members.map((member) => (
            <span key={member.botId} title={member.name}>
              <BotAvatar name={member.name} size={24} />
            </span>
          ))}
        </div>
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
          return (
            <div key={message.id} data-room-message data-id={message.id} className="flex gap-3">
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
              </div>
            </div>
          );
        })}
      </div>
      <form onSubmit={submit} className="flex items-end gap-2 border-t p-3">
        <Textarea
          aria-label={t("bots.message")}
          placeholder={t("bots.message")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          className="max-h-40 min-h-10 resize-none"
        />
        <Button
          type="submit"
          size="icon"
          aria-label={t("bots.send")}
          disabled={!draft.trim() || room.members.length < 2}
        >
          <SendIcon />
        </Button>
      </form>
    </section>
  );
}
