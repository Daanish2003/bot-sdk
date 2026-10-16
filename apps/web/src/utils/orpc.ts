import { type BotSdkClient, createBotSdkClient } from "@ai-chat/bot-sdk/core/client";
import { assistantClient } from "@ai-chat/bot-sdk/plugins/assistant/client";
import { botClient } from "@ai-chat/bot-sdk/plugins/bot/client";
import { modelsClient } from "@ai-chat/bot-sdk/plugins/models/client";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { toast } from "sonner";

import { sdk } from "../services";

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        toast.error(`Error: ${error.message}`, {
          action: {
            label: "retry",
            onClick: () => {
              query.invalidate();
            },
          },
        });
      },
    }),
    defaultOptions: { queries: { staleTime: 60 * 1000 } },
  });
}

// On the server the client calls the chat handler in process; in the browser it calls the route.
const getChatClient = createIsomorphicFn()
  .server((): BotSdkClient =>
    createBotSdkClient({
      baseUrl: "http://localhost/api/chat",
      plugins: [modelsClient(), assistantClient(), botClient()],
      fetch: (request) => {
        // A call made while rendering carries the page request's cookies, so `getUser` sees the session.
        const headers = new Headers(request.headers);
        const cookie = getRequest().headers.get("cookie");
        if (cookie) headers.set("cookie", cookie);
        return sdk.handler(new Request(request, { headers }));
      },
    }),
  )
  .client((): BotSdkClient =>
    createBotSdkClient({
      baseUrl: `${window.location.origin}/api/chat`,
      plugins: [modelsClient(), assistantClient(), botClient()],
    }),
  );

export const chatClient = getChatClient();

export const orpc = chatClient.orpc;
