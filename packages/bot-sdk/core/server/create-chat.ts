import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";

import { postgresBlobStore, createDb } from "./storage";
import type { BlobStore } from "./storage";
import { handleConversationEvents } from "./chat/conversation-events";
import { createHookEmitter } from "./chat/hooks";
import type { ChatUser, Context } from "./context";
import { createGuardedFetch } from "./lib/guarded-fetch";
import {
  checkFeature,
  contextOf,
  enableFeature,
  featurePlugin,
  type AnyFeature,
  type FeatureApis,
} from "./feature";
import { assertMigrated, migrate as migrateSchema } from "./migrate";
import {
  matchPath,
  mergeRateLimits,
  mergeRouters,
  mergeRoutes,
  type BotSdkContext,
  type BotSdkPlugin,
  type CoreRule,
  type HooksOf,
  type RateLimitsOf,
  type Route,
} from "./plugin";
import { defaultRateLimits, rateLimitedFor, rpcRateLimits, type RateLimit } from "./rate-limits";
import { memoryRuntime, type BotSdkRuntime } from "./runtime";
import { deleteUserData, exportUserData, type UserExport } from "./user-data";
import { bot, botJobs, type BotApi } from "../../plugins/bot/server/plugin";
import { channel, createChannels } from "../../plugins/bot/server/channels";
import type { ChannelAdapter, ChannelApi } from "../../plugins/channel/server/internal";
import { computerSleepJob, createComputer } from "../../plugins/computer/server/internal";
import type { ComputerProvider } from "../../plugins/computer/server/internal";
import {
  models,
  type ModelsApi,
  type ModelsOptions,
  type ModelsPlugin,
} from "../../plugins/models/server/internal";
import type {
  CoreJobServices,
  Executor,
  JobDefinition,
  JobRunner,
} from "../../plugins/runner/server/internal";
import { createRunner, jobTable, type RunnerApi } from "../../plugins/runner/server/internal";

export type ChatHandler = (request: Request) => Promise<Response>;

/** Where the RPC calls' errors go, and the SDK's warnings when it has `warn`. */
export type Logger = Pick<Console, "error"> & Partial<Pick<Console, "warn">>;

export type GetUser = (request: Request) => ChatUser | null | Promise<ChatUser | null>;

/** What the `features` slot takes: features built with `defineFeature`. */
export type FeatureEntry = AnyFeature;

/**
 * The factory's options (spec #871): the Bot core is always on, Models are configured in `models`,
 * and infrastructure goes in flat adapter slots, each with a default.
 */
export type BotSdkOptions<Features extends readonly FeatureEntry[] = readonly FeatureEntry[]> = {
  databaseUrl: string;
  /** Who the request is from. `null` answers 401, except on a public route. */
  getUser: GetUser;
  /**
   * The keyring (ADR 0010), at least one secret. The first encrypts Provider and Tool credentials
   * at rest; every entry decrypts, so a key can be added in front of the old one.
   */
  keyEncryptionSecrets: string[];
  /** Where the handler is mounted, for example `/api/chat`. */
  basePath: string;
  /**
   * What the SDK shares across processes: pub/sub and the rate-limit counters (`redisRuntime`).
   * Defaults to in-memory, which works in one process only; `start()` warns about it.
   */
  pubsub?: BotSdkRuntime;
  /**
   * Where the SDK's own failures go (background writes, usage rows, the database pool, the job
   * reaper) and the RPC calls' errors. Defaults to `console`.
   */
  logger?: Logger;
  /**
   * Test-only: `host` or `host:port` entries the guarded `fetch` may reach over plain HTTP and at
   * a private address (the end-to-end tests' fake servers). Never set it in production; `apps/web` sets
   * it only from `SSRF_ALLOW_HOSTS`, which needs a localhost `BETTER_AUTH_URL`.
   */
  fetchAllowHosts?: string[];
  /**
   * Where file bytes are kept (ADR 0015). Defaults to a `chat.blob` table in the same database;
   * a Host with object storage passes its store, and then the bytes of files already stored
   * stay where they are.
   */
  blobs?: BlobStore;
  /**
   * Whether the Host has banned a user (spec #277). A banned owner's Routines, Check-ins and
   * Channel messages don't start Turns. Unset, nobody is blocked.
   */
  isUserBlocked?: (userId: string) => boolean | Promise<boolean>;
  /**
   * The optional capabilities (spec #871): features built with `defineFeature`, each API served
   * as `sdk.<id>`.
   */
  features?: Features;
  /**
   * Wakes up and runs the background jobs (an Executor). Defaults to the in-process Executor,
   * which polls Postgres and needs nothing else.
   */
  runner?: Executor;
  /**
   * The Host's own jobs, built with `defineJob` (spec #872): they run on the SDK's runner, each
   * with the core services a feature with no `needs` gets. A job name can be listed once.
   */
  // oxlint-disable-next-line typescript/no-explicit-any -- each job has its own payload
  jobs?: readonly JobDefinition<any>[];
  /** Each user's Computer. With none, Bots have no Computer and no feature that needs one. */
  computer?: ComputerProvider;
  /** The Models: Host credentials, user keys, Quota, linked credentials, default Image Model. */
  models: ModelsOptions;
  /** The Channels besides web, each an adapter (email). With none, Bots talk on the web only. */
  channels?: readonly ChannelAdapter[];
  /**
   * The user's verified account email, or `null` when they have none: only mail from it reaches
   * their Bots. Unset, none does.
   */
  verifiedEmail?: (userId: string) => Promise<string | null>;
  /**
   * The Model that reviews each Bot's risky tool calls before they run (Auto-review), a
   * `"provider:model"` id from the Models' list, resolved per user. Unset, or one the user can't
   * use, the Bot's own Model reviews, in a fresh context.
   */
  reviewModel?: string;
  /** Overrides for the core's rate limits (spec 87). Each rule is optional; `false` turns it off. */
  rateLimits?: RateLimitsOf<[ModelsPlugin]>;
  /**
   * The Host's callbacks into the SDK. Each hook is optional and runs after its change is written,
   * never awaited, at most once and without retries (README, "Host hooks").
   */
  hooks?: HooksOf<[ModelsPlugin]>;
};

export type BotSdk = {
  handler: ChatHandler;
  /** The runner's jobs: `runJob` is what a Host's own worker (such as a Trigger.dev task) calls. */
  runner: RunnerApi;
  /** The core's Models (spec #871): metering, the Quota and the Admin views' usage reads. */
  models: ModelsApi;
  /**
   * The core's Bots (spec #871): the Routines' webhook handler, the live view's handler and
   * socket, and `stopTurns` for a Ban.
   */
  bots: BotApi;
  /** The core's Channels (spec #871): the inbound handler of each adapter in the channels slot. */
  channels: ChannelApi;
  /** Creates the `chat` schema and applies the bundled migrations. Run it at deploy time. */
  migrate: () => Promise<void>;
  /**
   * Refuses (throws) while the `chat` schema is behind the bundled migrations; then starts the
   * core's parts, in order. `models` refuses with neither `hostProviders` nor `byok` on; the
   * runner starts its job reaper and the jobs runner (ADR 0011).
   */
  start: () => Promise<void>;
  /**
   * Sets `stopping`, stops the core's parts in reverse order, then closes the runtime's
   * connections. The runner drains its jobs for up to 250 s, then aborts the rest and waits up to
   * 250 s more for their handlers to end. A part whose stop throws doesn't stop the others; its
   * error is rethrown once the runtime closes. Call it on SIGTERM.
   */
  stop: () => Promise<void>;
  /** Deletes everything the core and the features hold for a user, in one transaction. Idempotent. */
  deleteUser: (userId: string) => Promise<void>;
  /**
   * Everything the SDK keeps for a user, as one document (`version: 2`): the core's `version`
   * and `exportedAt`, and each exporting part under its id (`bot`, `models`, a feature's). Empty for an unknown id.
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
export type GivenContext = Partial<
  Omit<
    BotSdkContext,
    "parts" | "rateLimit" | "models" | "runner" | "computer" | "bots" | "channels"
  > & {
    /** A runner built by the test seam, in place of one over the runner slot's Executor. */
    jobs: JobRunner;
  }
>;

/**
 * The Bot SDK for a Host (spec #871): the Bot core over the slots, with the listed features.
 * Construction checks each feature's `needs` and schema, and the router keys. Nothing connects,
 * starts or queries until the first request, so the Host can build it at import time.
 */
export function createBotSdk<const Features extends readonly FeatureEntry[] = []>(
  options: BotSdkOptions<Features>,
): BotSdk & FeatureApis<Features> {
  return buildBotSdk(options, {}).instance as BotSdk & FeatureApis<Features>;
}

/**
 * The core's parts the slots configure: Models (`modelsPart`, by default the models slot's), the
 * Bots, and the Channels when their slot is set. Models come first, so every other part's `init`
 * finds `sdk.models` set.
 */
export function coreParts(options: BotSdkOptions, modelsPart?: BotSdkPlugin): BotSdkPlugin[] {
  if (!modelsPart && !options.models) {
    throw new Error("Models aren't configured: set the models slot");
  }
  return [
    modelsPart ?? models(options.models),
    bot({ reviewModel: options.reviewModel }),
    ...(options.channels
      ? [
          channel({
            adapters: options.channels,
            verifiedEmail: options.verifiedEmail ?? (async () => null),
          }),
        ]
      : []),
  ];
}

/**
 * The instance over `options`, with any `given` part of the core context in its place, and the
 * core's parts (`core`: by default the ones the slots configure; Models first, since the other
 * parts' inits read them). The factory and the tests' instances share it.
 */
export function buildBotSdk(
  options: BotSdkOptions,
  given: GivenContext,
  parts?: readonly BotSdkPlugin[],
): { instance: BotSdk; context: BotSdkContext } {
  if (options.keyEncryptionSecrets.length === 0) {
    throw new Error("keyEncryptionSecrets must hold at least one secret");
  }
  if (!options.basePath.startsWith("/")) {
    throw new Error(`basePath must start with "/": ${options.basePath}`);
  }
  const core = parts ?? coreParts(options);
  if (core[0]?.id !== "models") throw new Error("The core's parts must start with Models");
  const features: readonly AnyFeature[] = options.features ?? [];
  // The core services the instance has: a feature's `needs` are checked against them.
  const services = new Set(["runner", ...(options.computer ? ["computer"] : [])]);
  const ids = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id)) throw new Error(`Feature "${feature.id}" is enabled twice`);
    ids.add(feature.id);
    checkFeature(feature, services);
  }
  // The core serves its own routes and rules beside its parts', so no part can claim them.
  const own: BotSdkPlugin = {
    id: "core",
    routes: coreRoutes((userId) => instance.exportUser(userId)),
    rateLimits: coreRateLimits,
  };
  const declared = [
    own,
    ...core,
    ...features.map(({ id, router, routes }): BotSdkPlugin => ({ id, router, routes })),
  ];
  const router = mergeRouters(declared);
  const routes = mergeRoutes(declared);
  const ruleDefaults = mergeRateLimits([own, ...core]);

  // Building the context opens nothing: the pool and the runtime connect on first use.
  const sdk = buildContext(options, given, ruleDefaults) as BotSdkContext;
  // The core services, over the context they belong to, before any part's `init` runs.
  const runner = createRunner(sdk, options.runner, given.jobs);
  sdk.runner = runner.api;
  sdk.computer = options.computer ? createComputer(sdk, options.computer) : null;
  // No Channel besides web, until the channels slot's init sets its adapters.
  sdk.channels = createChannels(sdk, { adapters: [], verifiedEmail: async () => null });
  // Each feature in the Host's order, with the core services it needs.
  const enabled = features.map((feature) => enableFeature(sdk, feature));
  const plugins = [...core, ...enabled.map(featurePlugin)];
  // Every job the runner runs: the core's, each feature's with its context, then the Host's.
  const coreServices: CoreJobServices = { deps: sdk };
  const jobs = jobTable([
    { jobs: [...botJobs, computerSleepJob], services: coreServices },
    ...enabled.map(({ feature, context }) => ({ jobs: feature.jobs ?? [], services: context })),
    { jobs: options.jobs ?? [], services: contextOf(sdk, []) },
  ]);
  sdk.parts = { all: plugins, features: enabled, jobs };
  // In order: the core's parts first, then each feature's API.
  const apis = new Map<string, object>();
  for (const plugin of plugins) apis.set(plugin.id, plugin.init?.(sdk)?.api ?? {});

  const instance: BotSdk = {
    handler: createHandler(options, router, routes, sdk),
    runner: sdk.runner,
    models: sdk.models,
    bots: sdk.bots,
    channels: sdk.channels,
    migrate: () =>
      migrateSchema(options.databaseUrl, {
        blobStore: options.blobs,
        logger: options.logger,
      }),
    start: async () => {
      await assertMigrated(options.databaseUrl);
      if (!options.pubsub && !given.runtime && !given.pubsub) {
        const logger = options.logger ?? console;
        const warning =
          "The Bot SDK's pub/sub is in memory, which works in one process only: set the pubsub slot (redisRuntime) when the Host runs more than one";
        // Called on the logger, so a class-based one keeps its `this`.
        if (logger.warn) logger.warn(warning);
        else logger.error(warning);
      }
      for (const plugin of plugins) await plugin.start?.(sdk);
      // The reaper, then the jobs runner.
      await runner.lifecycle.start();
    },
    stop: async () => {
      sdk.lifecycle.stopping = true;
      // Every part stops even when one throws, and the runtime closes after them all, so the
      // process can still exit. The failures are thrown once it has.
      const errors: unknown[] = [];
      for (const plugin of [...plugins].reverse()) {
        try {
          await plugin.stop?.(sdk);
        } catch (error) {
          errors.push(error);
        }
      }
      // Drains the jobs, once the parts that queue them have stopped.
      try {
        await runner.lifecycle.stop();
      } catch (error) {
        errors.push(error);
      }
      await options.pubsub?.close?.();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Several parts failed to stop");
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
  // Each feature's API, as `sdk.<id>`.
  for (const feature of features) Object.assign(instance, { [feature.id]: apis.get(feature.id) });
  return { instance, context: sdk };
}

/** The core context: the infrastructure from the options, with any `given` part in its place. */
function buildContext(
  options: BotSdkOptions,
  given: GivenContext,
  ruleDefaults: ReturnType<typeof mergeRateLimits>,
): Omit<BotSdkContext, "runner" | "computer" | "channels" | "parts"> {
  const logger = options.logger ?? console;
  const db = given.db ?? createDb({ DATABASE_URL: options.databaseUrl }, logger);
  const runtime = given.runtime ?? options.pubsub ?? memoryRuntime();
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
    blobStore: given.blobStore ?? options.blobs ?? postgresBlobStore(db),
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
        throw new Error(`Nothing in the instance declares the rate limit "${rule}"`);
      return rateLimitedFor(counters, limit, key);
    },
    // Set by the Models' init, which runs before every other part's.
    models: modelsUnconfigured,
    // Set by the Bots' init, which the core always runs.
    bots: botsUnconfigured,
  };
}

/** Every name of the Models' API, so the unconfigured stand-in throws on those alone. */
const modelsApiKeys: Record<keyof ModelsApi, true> = {
  resolveModelCall: true,
  resolveToolCall: true,
  resolvePayer: true,
  resolveModel: true,
  listAvailableModels: true,
  resolveImageModel: true,
  imageModelSetting: true,
  saveImageModelSetting: true,
  resolveUserImageModel: true,
  readQuota: true,
  messageUsage: true,
  loadCredentials: true,
  adapterFor: true,
  adapterForCall: true,
  freeModelMeter: true,
  addRecentModelSource: true,
  imageAdapterFor: true,
  imageRequestFor: true,
  byok: true,
  defaultImageModel: true,
  hasHostImageModels: true,
  usageTotals: true,
  usage: true,
  quota: true,
};

/**
 * The `models` service of an instance whose core parts have no `models()`: reading any part of
 * its API throws. Other keys read as unset, so printing, serialising or awaiting it doesn't.
 */
const modelsUnconfigured = new Proxy({} as ModelsApi, {
  get: (_target, key) => {
    if (typeof key === "string" && key in modelsApiKeys) {
      throw new Error("Models aren't configured: set the models slot");
    }
    return undefined;
  },
});

/** The `bot` service of an instance whose core parts have no `bot()`: reading its API throws. */
const botsUnconfigured = new Proxy({} as BotApi, {
  get: (_target, key) => {
    if (typeof key === "string" && key in botApiKeys) {
      throw new Error("The Bots aren't enabled: build the SDK with the slots");
    }
    return undefined;
  },
});

/** Every name of the Bots' API, so the stand-in throws on those alone. */
const botApiKeys: Record<keyof BotApi, true> = {
  webhookHandler: true,
  stopTurns: true,
  screenHandler: true,
  screenSocket: true,
  reviewModel: true,
};

function createHandler(
  { basePath, getUser, logger = console }: BotSdkOptions,
  router: ReturnType<typeof mergeRouters>,
  routes: readonly Route[],
  sdk: BotSdkContext,
): ChatHandler {
  const prefix = basePath.replace(/\/+$/, "");
  const rpcPrefix = `${prefix}/rpc` as `/${string}`;
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
    if (!user) return unauthorized();

    if (pathname === rpcPrefix || pathname.startsWith(`${rpcPrefix}/`)) {
      const refused = await rpcRateLimitRefusal(sdk, user.id, pathname.slice(rpcPrefix.length));
      if (refused) return refused;
      const context: Context = { user, sdk };
      const result = await rpc.handle(request, { prefix: rpcPrefix, context });
      return result.matched ? result.response : notFound();
    }
    const privateRoute = matchRoute(request, path, false);
    if (privateRoute && !privateRoute.route.public) {
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
