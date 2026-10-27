import { createBotSdkClient } from "@botsdk/client";
import { channelClient } from "@botsdk/client";
import { knowledgeClient } from "@botsdk/knowledge/client";
import { mcpClient } from "@botsdk/mcp/client";
import { memoryClient } from "@botsdk/memory/client";
import { skillsClient } from "@botsdk/skills/client";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { toast } from "sonner";

import { ENV } from "../env.server";
import { http } from "../services";

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

// The client is built from the core's contract and each enabled feature's client part.
const features = [
  memoryClient(),
  skillsClient(),
  knowledgeClient(),
  mcpClient(),
  channelClient(),
] as const;

type ChatClient = ReturnType<typeof createBotSdkClient<typeof features>>;

// On the server the client calls the chat handler in process; in the browser it calls the route.
// The server's base is still the app's origin: its URLs (images, files, export) go into the
// server-rendered HTML, and hydration keeps them (#821).
const getChatClient = createIsomorphicFn()
  .server((): ChatClient =>
    createBotSdkClient({
      baseUrl: `${ENV.BETTER_AUTH_URL}/api/chat`,
      features,
      fetch: (request) => {
        // A call made while rendering carries the page request's cookies, so `getUser` sees the session.
        const headers = new Headers(request.headers);
        const cookie = getRequest().headers.get("cookie");
        if (cookie) headers.set("cookie", cookie);
        return http(new Request(request, { headers }));
      },
    }),
  )
  .client((): ChatClient =>
    createBotSdkClient({ baseUrl: `${window.location.origin}/api/chat`, features }),
  );

export const chatClient = getChatClient();

export const orpc = chatClient.orpc;
