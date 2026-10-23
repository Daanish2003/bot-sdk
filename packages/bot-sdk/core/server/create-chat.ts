import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";

import { postgresBlobStore } from "./blob/postgres";
import type { BlobStore } from "./blob/store";
import { handleConversationEvents } from "./chat/conversation-events";
import { createHookEmitter } from "./chat/hooks";
import type { ChatUser, Context } from "./context";
import { createDb } from "./db/index";
import { createGuardedFetch } from "./lib/guarded-fetch";
import { assertMigrated, migrate as migrateSchema } from "./migrate";
import {
  bindPlugins,
  matchPath,
  mergeRateLimits,
  mergeRouters,
  mergeRoutes,
  orderPlugins,
  type BotSdkContext,
  type BotSdkPlugin,
  type CoreRule,
  type HooksOf,
  type PluginApis,
  type RateLimitsOf,
  type Route,
} from "./plugin";
import { defaultRateLimits, rateLimitedFor, rpcRateLimits, type RateLimit } from "./rate-limits";
import { coreRouter } from "./routers/index";
import { memoryRuntime, type BotSdkRuntime } from "./runtime";
import { deleteUserData, exportUserData, type UserExport } from "./user-data";

export type ChatHandler = (request: Request) => Promise<Response>;

/** Where the RPC calls' errors go. */
export type Logger = Pick<Console, "error">;

export type GetUser = (request: Request) => ChatUser | null | Promise<ChatUser | null>;

export type BotSdkOptions<Plugins extends readonly BotSdkPlugin[] = readonly BotSdkPlugin[]> = {
  databaseUrl: string;
  /** Who the request is from. `null` answers 401, except for the public Shared link read. */
  getUser: GetUser;
  /**
   * The keyring (ADR 0010), at least one secret. The first encrypts Provider and Tool credentials
   * at rest; every entry decrypts, so a key can be added in front of the old one.
   */
  keyEncryptionSecrets: string[];
  /** Where the handler is mounted, for example `/api/chat`. */
  basePath: string;
  runtime?: BotSdkRuntime;
  /**
   * Overrides for the enabled plugins' rate limits (spec 87). Each rule is optional; `false` turns
   * it off.
   */
  rateLimits?: RateLimitsOf<Plugins>;
  /**
   * The client's IP, for the per-IP limit on Shared link views. The Host reads it from its own
   * request (for example, a header its proxy sets). The SDK trusts no forwarded header by default,
   * so without this option there are no per-IP limits.
   */
  getClientIp?: (request: Request) => string | null | Promise<string | null>;
  /**
   * Where the SDK's own failures go (background writes, usage rows, title generation, the database
   * pool, the reaper) and the RPC calls' errors. Defaults to `console`.
   */
  logger?: Logger;
  /**
   * The Host's callbacks into the SDK, for the events the enabled plugins fire. Each hook is
   * optional and runs after its change is written, never awaited, at most once and without retries
   * (README, "Host hooks").
   */
  hooks?: HooksOf<Plugins>;
  /**
   * Test-only: `host` or `host:port` entries that `fetch_url` may reach over plain HTTP and at a
   * private address (the end-to-end tests' fake page). Never set it in production; `apps/web` sets
   * it only from `SSRF_ALLOW_HOSTS`, which needs a localhost `BETTER_AUTH_URL`.
   */
  fetchAllowHosts?: string[];
  /**
   * Where file bytes are kept (ADR 0015). Defaults to a `chat.blob` table in the same database;
   * a Host with object storage passes its store, and then the bytes of files already stored
   * stay where they are.
   */
  blobStore?: BlobStore;
  /**
   * Whether the Host has banned a user (spec #277). A banned owner's Shared links are not found:
   * they can't be read or continued. Unset, nobody is blocked.
   */
  isUserBlocked?: (userId: string) => boolean | Promise<boolean>;
  /** The features this instance serves (ADR 0020), such as `assistant()`. */
  plugins: Plugins;
};

export type BotSdk = {
  handler: ChatHandler;
  /** An enabled plugin's API. Throws for a plugin that isn't enabled. */
  plugin: BotSdkContext["plugin"];
  /** Creates the `chat` schema and applies the bundled migrations. Run it at deploy time. */
  migrate: () => Promise<void>;
  /**
   * Refuses (throws) while the `chat` schema is behind the bundled migrations; then starts each
   * plugin, in dependency order. `models` refuses with neither `hostProviders` nor `byok` on; the
   * runner starts its job reaper and the jobs runner (ADR 0011), and the assistant starts its Run
   * reaper (now, and every 30 s, ADR 0006).
   */
  start: () => Promise<void>;
  /**
   * Sets `stopping`, stops each plugin in reverse dependency order, then closes the runtime's
   * connections. The assistant refuses new Runs with 503 and lets local Runs finish for up to
   * `drainMs` (250 s), then ends the rest as interrupted; after it, the runner drains its jobs for
   * up to 250 s, then aborts the rest and waits up to 250 s more for their handlers to end. A
   * plugin whose stop
   * throws doesn't stop the others; its error is rethrown once the runtime closes. Call it on
   * SIGTERM.
   */
  stop: () => Promise<void>;
  /** Deletes everything every plugin holds for a user, in one transaction. Idempotent. */
  deleteUser: (userId: string) => Promise<void>;
  /**
   * Everything the SDK keeps for a user, as one document (`version: 2`): the core's `version`
   * and `exportedAt`, and each exporting plugin's part under its plugin id. Empty for an unknown id.
   */
  exportUser: (userId: string) => Promise<UserExport>;
  /**
   * Re-encrypts every stored secret under the keyring's first secret (ADR 0010). Batched and safe
   * to re-run. `unreadable` counts rows no key can read; they are left in place and logged. Run it
   * as a one-off command, never in the pre-deploy step.
   */
  rotateKeys: () => Promise<{ reencrypted: number; unreadable: number }>;
};

/** The rate-limit rules the core declares itself, and their defaults. */
const coreRateLimits: Record<CoreRule, RateLimit> = {
  attachmentUpload: defaultRateLimits.attachmentUpload,
  conversationSearch: defaultRateLimits.conversationSearch,
};

/** The core's non-RPC routes, under `basePath`. */
function coreRoutes(exportUser: BotSdk["exportUser"]): Route[] {
  return [
    {
      method: "GET",
      path: "/events",
      handle: (request, { user, sdk }) => handleConversationEvents(request, user, sdk),
    },
    {
      method: "GET",
      path: "/export",
      handle: async (_request, { user }) => exportResponse(await exportUser(user.id)),
    },
  ];
}

/** The user's export as a JSON download; the file is named by the date the export was taken. */
function exportResponse(document: UserExport) {
  const date = document.exportedAt.toISOString().slice(0, 10);
  return Response.json(document, {
    headers: { "Content-Disposition": `attachment; filename="chat-export-${date}.json"` },
  });
}

/** The parts of the core context a test may give instead of having them built. */
export type GivenContext = Partial<Omit<BotSdkContext, "plugin" | "hasPlugin" | "rateLimit">>;

/**
 * The Bot SDK for a Host: one instance over its plugins (ADR 0020). Construction checks each
 * plugin's `requires` and the router keys, then runs each plugin's `init` in dependency order.
 * Nothing connects, starts or queries until the first request, so the Host can build it at import
 * time.
 */
export function createBotSdk<const Plugins extends readonly BotSdkPlugin[]>(
  options: BotSdkOptions<Plugins>,
): BotSdk {
  return buildBotSdk(options, {}).instance;
}

export function buildBotSdk(
  options: BotSdkOptions,
  given: GivenContext,
): { instance: BotSdk; context: BotSdkContext } {
  if (options.keyEncryptionSecrets.length === 0) {
    throw new Error("keyEncryptionSecrets must hold at least one secret");
  }
  if (!options.basePath.startsWith("/")) {
    throw new Error(`basePath must start with "/": ${options.basePath}`);
  }
  const plugins = orderPlugins(options.plugins);
  // The core serves its own routers, routes and rules beside the plugins', so a plugin can't claim them.
  const core: BotSdkPlugin = {
    id: "core",
    router: coreRouter,
    routes: coreRoutes((userId) => instance.exportUser(userId)),
    rateLimits: coreRateLimits,
  };
  const router = mergeRouters([core, ...plugins]);
  const routes = mergeRoutes([core, ...plugins]);
  const ruleDefaults = mergeRateLimits([core, ...plugins]);

  const apis = new Map<string, object>();
  // Building the context opens nothing: the pool and the runtime connect on first use.
  const enabledIds = new Set(plugins.map((plugin) => plugin.id));
  const sdk = buildContext(options, given, ruleDefaults, enabledIds, (id) => {
    const api = apis.get(id);
    if (!api) throw new Error(`Plugin "${id}" isn't enabled`);
    return api;
  });
  // In dependency order, so a plugin's `init` can call the plugins it requires.
  for (const plugin of plugins) apis.set(plugin.id, plugin.init?.(sdk)?.api ?? {});
  bindPlugins(sdk, plugins);

  const instance: BotSdk = {
    handler: createHandler(options, router, routes, sdk),
    plugin: sdk.plugin,
    migrate: () => migrateSchema(options.databaseUrl, { blobStore: options.blobStore }),
    start: async () => {
      await assertMigrated(options.databaseUrl);
      for (const plugin of plugins) await plugin.start?.(sdk);
    },
    stop: async () => {
      sdk.lifecycle.stopping = true;
      // Every plugin stops even when one throws, and the runtime closes after them all, so the
      // process can still exit. The failures are thrown once it has.
      const errors: unknown[] = [];
      for (const plugin of [...plugins].reverse()) {
        try {
          await plugin.stop?.(sdk);
        } catch (error) {
          errors.push(error);
        }
      }
      await options.runtime?.close?.();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Several plugins failed to stop");
    },
    deleteUser: (userId) => deleteUserData(sdk, userId),
    exportUser: (userId) => exportUserData(sdk, userId),
    rotateKeys: async () => {
      const total = { reencrypted: 0, unreadable: 0 };
      for (const plugin of plugins) {
        const counts = await plugin.rotateKeys?.(sdk);
        total.reencrypted += counts?.reencrypted ?? 0;
        total.unreadable += counts?.unreadable ?? 0;
      }
      return total;
    },
  };
  return { instance, context: sdk };
}

/** The core context: the infrastructure from the options, with any `given` part in its place. */
function buildContext(
  options: BotSdkOptions,
  given: GivenContext,
  ruleDefaults: ReturnType<typeof mergeRateLimits>,
  enabledIds: ReadonlySet<string>,
  plugin: (id: string) => object,
): BotSdkContext {
  const logger = options.logger ?? console;
  const db = given.db ?? createDb({ DATABASE_URL: options.databaseUrl }, logger);
  const runtime = given.runtime ?? options.runtime ?? memoryRuntime();
  const counters = given.counters ?? runtime.counters;
  const overrides: Partial<Record<string, RateLimit | false>> = options.rateLimits ?? {};
  // A given rule replaces its default; the rest keep theirs, so `rateLimit` finds every rule.
  const rateLimits = {
    ...Object.fromEntries(
      Object.entries(ruleDefaults).map(([rule, limit]) => [rule, overrides[rule] ?? limit]),
    ),
    ...given.rateLimits,
  };
  const fetchAllowHosts = given.fetchAllowHosts ?? options.fetchAllowHosts ?? [];
  return {
    db,
    blobStore: given.blobStore ?? options.blobStore ?? postgresBlobStore(db),
    runtime,
    pubsub: given.pubsub ?? runtime.pubsub,
    counters,
    logger: given.logger ?? logger,
    events: given.events ?? createHookEmitter(options.hooks, logger),
    fetch:
      given.fetch ?? createGuardedFetch({ schemes: "http-and-https", allowHosts: fetchAllowHosts }),
    fetchAllowHosts,
    clock: given.clock ?? (() => new Date()),
    keyring: given.keyring ?? options.keyEncryptionSecrets,
    lifecycle: given.lifecycle ?? { stopping: false },
    isUserBlocked: given.isUserBlocked ?? options.isUserBlocked ?? (() => false),
    rateLimits,
    rateLimit: (rule, key) => {
      const limit = rateLimits[rule];
      if (limit === undefined)
        throw new Error(`No enabled plugin declares the rate limit "${rule}"`);
      return rateLimitedFor(counters, limit, key);
    },
    plugin: <Id extends keyof PluginApis>(id: Id) => plugin(id) as PluginApis[Id],
    // From the plugin list, so it holds already in an `init` that runs before the other plugin's.
    hasPlugin: (id) => enabledIds.has(id),
  };
}

function createHandler(
  { basePath, getUser, getClientIp, logger = console }: BotSdkOptions,
  router: ReturnType<typeof mergeRouters>,
  routes: readonly Route[],
  sdk: BotSdkContext,
): ChatHandler {
  const prefix = basePath.replace(/\/+$/, "");
  const rpcPrefix = `${prefix}/rpc` as `/${string}`;
  // The RPCs a signed-out visitor of a Shared link may call (ADR 0004, ADR 0016).
  const sharedReadPaths = [`${rpcPrefix}/share/get`, `${rpcPrefix}/share/artifactVersion`];
  const rpc = new RPCHandler(router, {
    interceptors: [onError((error) => logger.error(error))],
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
      return route.handle(request, { user: null, sdk, params, basePath: prefix });
    }
    const user = await getUser(request);
    const sharedRead = sharedReadPaths.includes(pathname);
    if (!user && !sharedRead) return unauthorized();

    if (pathname === rpcPrefix || pathname.startsWith(`${rpcPrefix}/`)) {
      if (sharedRead && getClientIp) {
        const refused = await sharedLinkRefusal(sdk, await getClientIp(request));
        if (refused) return refused;
      }
      if (user) {
        const refused = await rpcRateLimitRefusal(sdk, user.id, pathname.slice(rpcPrefix.length));
        if (refused) return refused;
      }
      const context: Context = { user, sdk };
      const result = await rpc.handle(request, { prefix: rpcPrefix, context });
      return result.matched ? result.response : notFound();
    }
    const privateRoute = user ? matchRoute(request, path, false) : null;
    if (user && privateRoute && !privateRoute.route.public) {
      const { route, params } = privateRoute;
      return route.handle(request, { user, sdk, params, basePath: prefix });
    }
    return notFound();
  };
}

/** Counts a hit on a limited RPC route and answers 429 with `Retry-After` once it is over its limit. */
async function rpcRateLimitRefusal(
  sdk: BotSdkContext,
  userId: string,
  route: string,
): Promise<Response | null> {
  const rule = rpcRateLimits[route];
  if (!rule || !(rule in sdk.rateLimits)) return null;
  return tooManyRequests(await sdk.rateLimit(rule, `${rule}:${userId}`));
}

/**
 * Counts a Shared link view against its client IP and answers 429 with `Retry-After` once that IP
 * is over its limit. With no IP (the Host gave none), nothing is counted.
 */
async function sharedLinkRefusal(sdk: BotSdkContext, ip: string | null): Promise<Response | null> {
  if (!ip || !("sharedLinkView" in sdk.rateLimits)) return null;
  return tooManyRequests(await sdk.rateLimit("sharedLinkView", `sharedLinkView:${ip}`));
}

function tooManyRequests(retryAfter: number | null): Response | null {
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
