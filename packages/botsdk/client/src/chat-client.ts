import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils, type RouterUtils } from "@orpc/tanstack-query";

import type { CoreContract } from "./contract";
import { throwIfRateLimited } from "./rate-limit";

/**
 * A feature's client part (spec #873): its id, the contract its server part serves under that id,
 * and the URLs it adds to the client, from the base URL the Host mounted the handler at.
 */
export type FeatureClient<
  Id extends string = string,
  Contract extends AnyContractRouter = AnyContractRouter,
  Urls extends object = object,
> = {
  id: Id;
  contract: Contract;
  urls?: (base: string) => Urls;
};

/** The features' contracts, each under its id, as the handler serves them. */
export type FeaturesContract<Features extends readonly FeatureClient[]> = {
  [Feature in Features[number] as Feature["id"]]: Feature["contract"];
};

type UnionToIntersection<U> = (U extends unknown ? (union: U) => void : never) extends (
  intersection: infer I,
) => void
  ? I
  : never;

/** The URLs the features add to the client. */
export type FeaturesUrls<Features extends readonly FeatureClient[]> = UnionToIntersection<
  {
    [Index in keyof Features]: Features[Index] extends FeatureClient<
      string,
      AnyContractRouter,
      infer Urls
    >
      ? Urls
      : never;
  }[number]
>;

/** The typed RPC client for a contract: the core's by default. */
export type BotSdkRpc<Contract extends AnyContractRouter = CoreContract> =
  ContractRouterClient<Contract>;

/** The oRPC TanStack Query utils over `BotSdkRpc`. */
export type BotSdkOrpc<Contract extends AnyContractRouter = CoreContract> = RouterUtils<
  BotSdkRpc<Contract>
>;

/** A request-level fetch: the global `fetch`, or the Host's handler when the Host runs the SDK in process. */
export type BotSdkFetch = (request: Request) => Promise<Response>;

/** The headless client: no React, no router. */
export interface BotSdkClient<Contract extends AnyContractRouter = CoreContract> {
  /** The typed RPC client for the core's and the features' procedures. */
  rpc: BotSdkRpc<Contract>;
  /** TanStack Query helpers over `rpc`, for the React UI. */
  orpc: BotSdkOrpc<Contract>;
  /** The signed-in user's export, a JSON download (`GET`). */
  exportUrl: string;
  /** The owner's live stream of a Conversation's events (`GET ?conversationId=`). */
  eventsUrl: string;
  /** A file the Bot sent, by id (`GET <botFilesUrl>/<id>`), a download; add `/inline` to show an image. */
  botFilesUrl: string;
  /** Where a webhook Routine's URL starts (ADR 0021): `<routineWebhookUrl>/<token>`. */
  routineWebhookUrl: string;
  /** The transport every RPC call goes through. */
  fetch: BotSdkFetch;
  /** The ids of the features this client was created with, in order. */
  features: readonly string[];
}

/**
 * `baseUrl` is where the Host mounted the handler, for example `https://app.example/api/chat`.
 * `features` pairs with the server's features: `[memoryClient(), mcpClient()]`. The client is typed
 * by the core's contract and theirs alone, and calls them all over one link.
 */
export function createBotSdkClient<const Features extends readonly FeatureClient[] = []>({
  baseUrl,
  fetch = (request) => globalThis.fetch(request),
  features = [] as unknown as Features,
}: {
  baseUrl: string;
  fetch?: BotSdkFetch;
  features?: Features;
}): BotSdkClient<CoreContract & FeaturesContract<Features>> & FeaturesUrls<Features> {
  const base = baseUrl.replace(/\/+$/, "");
  const rpc: BotSdkRpc<CoreContract & FeaturesContract<Features>> = createORPCClient(
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
      botFilesUrl: `${base}/bot-files`,
      routineWebhookUrl: `${base}/routines/webhook`,
      fetch,
      features: features.map((feature) => feature.id),
    },
    ...features.map((feature) => feature.urls?.(base) ?? {}),
  ) as BotSdkClient<CoreContract & FeaturesContract<Features>> & FeaturesUrls<Features>;
}
