import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";

import type { ChatUser, Context } from "../server/context";
import { httpPartsOf, type BotSdk } from "../server/create-chat";
import { matchPath, type BotSdkContext, type RateLimitsOf } from "../server/plugin";
import { rateLimitedFor, rpcRateLimits, type RateLimit } from "../server/rate-limits";
import type { ModelsPlugin } from "../../plugins/models/server/internal";

/** A fetch handler: one `Request` in, one `Response` out. */
export type HttpHandler = (request: Request) => Promise<Response>;

/** Who a request is from, by the Host's own sign-in. `null` answers 401, except on a public route. */
export type GetUser = (request: Request) => ChatUser | null | Promise<ChatUser | null>;

export type HttpHandlerOptions = {
  /** Who the request is from. `null` answers 401, except on a public route. */
  getUser: GetUser;
  /** Where the handler is mounted, for example `/api/chat`. */
  basePath: string;
  /**
   * Overrides for the per-user rate limits of HTTP calls (spec 87). Each rule is optional; `false`
   * turns it off. In-process calls on the SDK are never limited.
   */
  rateLimits?: RateLimitsOf<[ModelsPlugin]>;
};

/**
 * The optional HTTP layer over a Bot SDK instance (spec #873): one fetch handler under `basePath`
 * serving every namespace's RPC routers under `/rpc`, the routes (server-sent change hints, the
 * export, each part's own) and the rate limits. Only here is a user read from a request.
 */
export function createHttpHandler(sdk: BotSdk, options: HttpHandlerOptions): HttpHandler {
  const { context, router, routes, rateLimits: defaults } = httpPartsOf(sdk);
  if (!options.basePath.startsWith("/")) {
    throw new Error(`basePath must start with "/": ${options.basePath}`);
  }
  const prefix = options.basePath.replace(/\/+$/, "");
  const rpcPrefix = `${prefix}/rpc` as `/${string}`;
  const overrides: Partial<Record<string, RateLimit | false>> = options.rateLimits ?? {};
  // An override replaces its rule's default; the rest keep theirs.
  const rules: Record<string, RateLimit | false> = Object.fromEntries(
    Object.entries(defaults).map(([rule, limit]) => [rule, overrides[rule] ?? limit]),
  );
  const rpc = new RPCHandler(router, {
    interceptors: [onError((error) => context.logger.error(error))],
  });
  const matchRoute = (request: Request, path: string | null, isPublic: boolean) => {
    if (path === null) return null;
    for (const route of routes) {
      if (route.method !== request.method || Boolean(route.public) !== isPublic) continue;
      const params = matchPath(route.path, path);
      if (params) return { route, params };
    }
    return null;
  };

  return async (request) => {
    const { pathname } = new URL(request.url);
    const path = pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : null;
    const publicRoute = matchRoute(request, path, true);
    if (publicRoute?.route.public) {
      const { route, params } = publicRoute;
      return route.handle(request, { user: null, sdk: context, params, basePath: prefix });
    }
    const user = await options.getUser(request);
    if (!user) return unauthorized();

    if (pathname === rpcPrefix || pathname.startsWith(`${rpcPrefix}/`)) {
      const route = pathname.slice(rpcPrefix.length);
      const refused = await rateLimitRefusal(context, rules, user.id, route);
      if (refused) return refused;
      const rpcContext: Context = { user, sdk: context };
      const result = await rpc.handle(request, { prefix: rpcPrefix, context: rpcContext });
      return result.matched ? result.response : notFound();
    }
    const privateRoute = matchRoute(request, path, false);
    if (privateRoute && !privateRoute.route.public) {
      const { route, params } = privateRoute;
      return route.handle(request, { user, sdk: context, params, basePath: prefix });
    }
    return notFound();
  };
}

/** Counts a hit on a limited RPC route and answers 429 with `Retry-After` once it is over its limit. */
async function rateLimitRefusal(
  context: BotSdkContext,
  rules: Readonly<Record<string, RateLimit | false>>,
  userId: string,
  route: string,
): Promise<Response | null> {
  const rule = rpcRateLimits[route];
  const limit = rule === undefined ? undefined : rules[rule];
  if (!rule || limit === undefined) return null;
  const retryAfter = await rateLimitedFor(context.counters, limit, `${rule}:${userId}`);
  if (retryAfter === null) return null;
  return Response.json(
    { code: "error.tooManyRequests", params: {} },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

function unauthorized() {
  return Response.json({ code: "error.unauthorized", params: {} }, { status: 401 });
}

function notFound() {
  return new Response("Not found", { status: 404 });
}
