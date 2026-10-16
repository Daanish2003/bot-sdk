import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SendIcon } from "lucide-react";
import { type FormEvent, Fragment, type KeyboardEvent, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import { useBotTurn } from "../client/react/bot-turn";
import { BotAvatar } from "./bot-avatar";

/**
 * A Bot's Conversation: the Messages sent in it, the user's on the right and the Bot's on the left,
 * ••• while a Turn runs, and "Seen ✓" under the user's last Message when the Bot stayed quiet, or "Couldn't reply" when the
 * Turn failed.
 */
export function BotConversation({ botId }: { botId: string }) {
  // One instance per Bot, so a Turn's state never shows on another Bot.
  return <BotConversationView key={botId} botId={botId} />;
}

function BotConversationView({ botId }: { botId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [draft, setDraft] = useState("");
  const { bot, error, messages, running, working, seenMessageId, failedMessageId, send } =
    useBotTurn(botId, {
      // A refused send puts its text back in the composer and says why.
      onRefusedSend: (text, refusal) => {
        setDraft(text);
        toast.error(serverErrorText(i18n, refusal));
      },
    });

  if (error) {
    return (
      <p className="m-auto p-4 text-sm text-muted-foreground">
        {serverErrorText(i18n, error, "error.botNotFound")}
      </p>
    );
  }
  if (!bot) return null;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    void send(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <BotAvatar name={bot.name} size={28} />
        <h1 className="font-semibold">{bot.name}</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="m-auto text-sm text-muted-foreground">{t("bots.noMessages")}</p>
        )}
        {messages.map((message) => (
          <Fragment key={message.id}>
            <div
              data-bot-message
              data-id={message.id}
              data-role={message.role}
              className={cn(
                "max-w-[70%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                message.role === "user"
                  ? "self-end bg-primary text-primary-foreground"
                  : "self-start bg-muted",
                message.pending && "opacity-70",
              )}
            >
              {message.text}
            </div>
            {message.id === seenMessageId && (
              <p className="self-end text-xs text-muted-foreground">{t("bots.seen")}</p>
            )}
            {message.id === failedMessageId && (
              <p className="self-end text-xs text-muted-foreground">{t("bots.couldntReply")}</p>
            )}
          </Fragment>
        ))}
        {working && (
          <div
            role="status"
            aria-label={t("bots.typing")}
            className="self-start rounded-2xl bg-muted px-3 py-2 text-sm tracking-widest text-muted-foreground"
          >
            •••
          </div>
        )}
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
          disabled={!draft.trim() || running}
        >
          <SendIcon />
        </Button>
      </form>
    </section>
  );
}
