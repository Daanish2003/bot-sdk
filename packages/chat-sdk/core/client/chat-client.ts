import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils, type RouterUtils } from "@orpc/tanstack-query";

import type { AppRouterClient } from "../server/routers/index";
import { throwIfRateLimited } from "./rate-limit";

/** The oRPC TanStack Query utils for the app router. */
export type ChatOrpc = RouterUtils<AppRouterClient>;

/** A request-level fetch: the global `fetch`, or the Host's handler when the Host runs the SDK in process. */
export type ChatFetch = (request: Request) => Promise<Response>;

/** The headless client: no React, no router. */
export type ChatClient = {
  /** The typed RPC client for the chat's procedures. */
  rpc: AppRouterClient;
  /** TanStack Query helpers over `rpc`, for the React UI. */
  orpc: ChatOrpc;
  /** Where a Run is posted (`POST`) and joined (`GET ?runId=`). */
  chatUrl: string;
  /** The signed-in user's export, a JSON download (`GET`). */
  exportUrl: string;
  /** Where the MCP sign-in starts (`GET ?server=<key>&returnTo=<path>`) and finishes. */
  connectionsUrl: string;
  /** The transport every RPC call goes through. */
  fetch: ChatFetch;
};

/** `baseUrl` is where the Host mounted the handler, for example `https://app.example/api/chat`. */
export function createChatClient({
  baseUrl,
  fetch = (request) => globalThis.fetch(request),
}: {
  baseUrl: string;
  fetch?: ChatFetch;
}): ChatClient {
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
    exportUrl: `${base}/export`,
    connectionsUrl: `${base}/mcp`,
    fetch,
  };
}
