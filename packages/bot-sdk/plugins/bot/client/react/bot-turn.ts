import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useChatAdapter } from "../../../../core/client/react/provider";
import type { BotMessage, TurnStatus } from "../../shared/turn";

/** A Message as the Conversation shows it: a saved one, or the user's Message still being sent. */
export type ShownBotMessage = BotMessage & { pending?: true };

/**
 * The client side of a Bot's Conversation: its Messages, and the Turn a send starts.
 *
 * The user's Message shows at once, and the stream's first event (the saved Message) replaces it.
 * Each Message the Bot sends joins the Conversation as it arrives. `seenMessageId` is the last
 * Message when it is the user's and the Turn ended `complete`: the Bot read it and chose to stay
 * quiet.
 */
export function useBotTurn(botId: string) {
  const { orpc } = useChatAdapter();
  const queryClient = useQueryClient();
  const getOptions = orpc.bot.get.queryOptions({ input: { botId } });
  const query = useQuery(getOptions);
  const [pending, setPending] = useState<ShownBotMessage>();
  const [running, setRunning] = useState(false);
  const [ended, setEnded] = useState<TurnStatus>();

  const append = (message: BotMessage) =>
    queryClient.setQueryData(getOptions.queryKey, (data) =>
      // A refetch during the Turn may already hold the Message.
      data && !data.messages.some((shown) => shown.id === message.id)
        ? { ...data, messages: [...data.messages, message] }
        : data,
    );

  const send = async (text: string) => {
    setPending({ id: "pending", role: "user", text, createdAt: new Date(), pending: true });
    setRunning(true);
    setEnded(undefined);
    try {
      for await (const event of await orpc.bot.send.call({ botId, text })) {
        if (event.type === "message") {
          setPending(undefined);
          append(event.message);
        } else {
          setEnded(event.status);
        }
      }
    } catch {
      setPending(undefined);
    } finally {
      setRunning(false);
    }
  };

  const messages: ShownBotMessage[] = [
    ...(query.data?.messages ?? []),
    ...(pending ? [pending] : []),
  ];
  const last = messages.at(-1);
  return {
    bot: query.data?.bot,
    error: query.error,
    messages,
    running,
    seenMessageId: !running && ended === "complete" && last?.role === "user" ? last.id : undefined,
    send,
  };
}
