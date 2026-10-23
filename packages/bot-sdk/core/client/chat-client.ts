import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils, type RouterUtils } from "@orpc/tanstack-query";

import type { CoreRouter } from "../server/routers/index";
import type { BotSdkClientPlugin, PluginRouters } from "./plugin";
import { throwIfRateLimited } from "./rate-limit";

type UnionToIntersection<U> = (U extends unknown ? (union: U) => void : never) extends (
  intersection: infer I,
) => void
  ? I
  : never;

/** The core's routers and every enabled plugin's, merged as the handler serves them. */
type MergedRouter = CoreRouter & UnionToIntersection<PluginRouters[keyof PluginRouters]>;

/** The typed RPC client for the core's procedures and the enabled plugins'. */
export type BotSdkRpc = RouterClient<MergedRouter>;

/** The oRPC TanStack Query utils for the merged routers. */
export type BotSdkOrpc = RouterUtils<BotSdkRpc>;

/** A request-level fetch: the global `fetch`, or the Host's handler when the Host runs the SDK in process. */
export type BotSdkFetch = (request: Request) => Promise<Response>;

/**
 * The headless client: no React, no router. A client plugin adds its URLs to it by declaration
 * merging (the assistant adds `chatUrl` and the rest).
 */
export interface BotSdkClient {
  /** The typed RPC client for the chat's procedures. */
  rpc: BotSdkRpc;
  /** TanStack Query helpers over `rpc`, for the React UI. */
  orpc: BotSdkOrpc;
  /** The signed-in user's export, a JSON download (`GET`). */
  exportUrl: string;
  /** The owner's live stream of a Conversation's events (`GET ?conversationId=`). */
  eventsUrl: string;
  /** The transport every RPC call goes through. */
  fetch: BotSdkFetch;
  /** The ids of the client plugins this client was created with, in order. */
  plugins: readonly string[];
}

/**
 * `baseUrl` is where the Host mounted the handler, for example `https://app.example/api/chat`.
 * `plugins` pairs with the server's plugins: `[modelsClient(), botClient()]`.
 */
export function createBotSdkClient({
  baseUrl,
  fetch = (request) => globalThis.fetch(request),
  plugins = [],
}: {
  baseUrl: string;
  fetch?: BotSdkFetch;
  plugins?: BotSdkClientPlugin[];
}): BotSdkClient {
  const base = baseUrl.replace(/\/+$/, "");
  const rpc: BotSdkRpc = createORPCClient(
    new RPCLink({
      url: `${base}/rpc`,
      fetch: async (request) => throwIfRateLimited(await fetch(request)),
    }),
  );
  return Object.assign(
    {
      rpc,
      orpc: createTanstackQueryUtils(rpc),
      exportUrl: `${base}/export`,
      eventsUrl: `${base}/events`,
      fetch,
      plugins: plugins.map((plugin) => plugin.id),
    },
    ...plugins.map((plugin) => plugin.urls?.(base) ?? {}),
  ) as BotSdkClient;
}
