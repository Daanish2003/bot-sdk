import { type BotSdkClient, createBotSdkClient } from "@ai-chat/bot-sdk/core/client";
import { botClient } from "@ai-chat/bot-sdk/plugins/bot/client";
import { knowledgeClient } from "@ai-chat/bot-sdk/plugins/knowledge/client";
import { mcpClient } from "@ai-chat/bot-sdk/plugins/mcp/client";
import { channelClient } from "@ai-chat/bot-sdk/plugins/channel/client";
import { memoryClient } from "@ai-chat/bot-sdk/plugins/memory/client";
import { modelsClient } from "@ai-chat/bot-sdk/plugins/models/client";
import { skillsClient } from "@ai-chat/bot-sdk/plugins/skills/client";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { toast } from "sonner";

import { ENV } from "../env.server";
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
// The server's base is still the app's origin: its URLs (images, files, export) go into the
// server-rendered HTML, and hydration keeps them (#821).
const getChatClient = createIsomorphicFn()
  .server((): BotSdkClient =>
    createBotSdkClient({
      baseUrl: `${ENV.BETTER_AUTH_URL}/api/chat`,
      plugins: [
        modelsClient(),
        memoryClient(),
        skillsClient(),
        knowledgeClient(),
        channelClient(),
        mcpClient(),
        botClient(),
      ],
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
      plugins: [
        modelsClient(),
        memoryClient(),
        skillsClient(),
        knowledgeClient(),
        channelClient(),
        mcpClient(),
        botClient(),
      ],
    }),
  );

export const chatClient = getChatClient();

export const orpc = chatClient.orpc;
