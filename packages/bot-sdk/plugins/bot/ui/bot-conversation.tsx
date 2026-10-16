import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";

import { useChatAdapter, useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import { BotAvatar } from "./bot-avatar";

/** A Bot's Conversation: the Messages sent in it, the user's on the right and the Bot's on the left. */
export function BotConversation({ botId }: { botId: string }) {
  const { orpc } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  const { data, error } = useQuery(orpc.bot.get.queryOptions({ input: { botId } }));
  if (error) {
    return (
      <p className="m-auto p-4 text-sm text-muted-foreground">
        {serverErrorText(i18n, error, "error.botNotFound")}
      </p>
    );
  }
  if (!data) return null;
  const { bot, messages } = data;

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
          <div
            key={message.id}
            className={cn(
              "max-w-[70%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
              message.role === "user"
                ? "self-end bg-primary text-primary-foreground"
                : "self-start bg-muted",
            )}
          >
            {message.text}
          </div>
        ))}
      </div>
    </section>
  );
}
