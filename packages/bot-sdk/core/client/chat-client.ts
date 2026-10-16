import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils, type RouterUtils } from "@orpc/tanstack-query";

import type { AppRouterClient } from "../server/routers/index";
import { throwIfRateLimited } from "./rate-limit";

/** The oRPC TanStack Query utils for the app router. */
export type BotSdkOrpc = RouterUtils<AppRouterClient>;

/** A request-level fetch: the global `fetch`, or the Host's handler when the Host runs the SDK in process. */
export type BotSdkFetch = (request: Request) => Promise<Response>;

/** The headless client: no React, no router. */
export type BotSdkClient = {
  /** The typed RPC client for the chat's procedures. */
  rpc: AppRouterClient;
  /** TanStack Query helpers over `rpc`, for the React UI. */
  orpc: BotSdkOrpc;
  /** Where a Run is posted (`POST`) and joined (`GET ?runId=`). */
  chatUrl: string;
  /** The owner's live stream of a Conversation's `memory_updated` events (`GET ?conversationId=`). */
  eventsUrl: string;
  /** The signed-in user's export, a JSON download (`GET`). */
  exportUrl: string;
  /** A Generated image's bytes, by id (`GET <generatedImagesUrl>/<id>`, `?download=1` to save). */
  generatedImagesUrl: string;
  /** A Generated image on a Shared link, by its token and id (`GET <base>/shared/<token>/generated-images/<id>`). */
  sharedGeneratedImagesUrl: (token: string) => string;
  /** Where the MCP sign-in starts (`GET ?server=<key>&returnTo=<path>`) and finishes. */
  connectionsUrl: string;
  /** The transport every RPC call goes through. */
  fetch: BotSdkFetch;
};

/** `baseUrl` is where the Host mounted the handler, for example `https://app.example/api/chat`. */
export function createBotSdkClient({
  baseUrl,
  fetch = (request) => globalThis.fetch(request),
}: {
  baseUrl: string;
  fetch?: BotSdkFetch;
}): BotSdkClient {
  const base = baseUrl.replace(/\/+$/, "");
  const rpc: AppRouterClient = createORPCClient(
    new RPCLink({
      url: `${base}/rpc`,
      fetch: async (request) => throwIfRateLimited(await fetch(request)),
    }),
  );
  return {
    rpc,
    orpc: createTanstackQueryUtils(rpc),
    chatUrl: `${base}/run`,
    eventsUrl: `${base}/events`,
    exportUrl: `${base}/export`,
    generatedImagesUrl: `${base}/generated-images`,
    sharedGeneratedImagesUrl: (token) => `${base}/shared/${token}/generated-images`,
    connectionsUrl: `${base}/mcp`,
    fetch,
  };
}
