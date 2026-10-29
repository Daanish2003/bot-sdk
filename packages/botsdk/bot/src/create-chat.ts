import { postgresBlobStore, databaseOf } from "./storage";
import type { BlobStore } from "./storage";
import { handleConversationEvents } from "./chat/conversation-events";
import { createHookEmitter } from "./chat/hooks";
import { createGuardedFetch } from "./lib/guarded-fetch";
import {
  checkFeature,
  contextOf,
  enableFeature,
  featureMigrations,
  featurePlugin,
  featureRouter,
  type AnyFeature,
  type FeatureApis,
  type ThreadsService,
} from "./feature";
import type { PostgresDatabase } from "./database";
import { assertMigrated, migrate as migrateSchema } from "./migrate";
import {
  mergeRateLimits,
  mergeRouters,
  mergeRoutes,
  normalizeBasePath,
  type BotSdkContext,
  type BotSdkPlugin,
  type CoreRule,
  type HooksOf,
  type Route,
} from "./plugin";
import { defaultRateLimits, type RateLimit } from "./rate-limits";
import { memoryRuntime, type BotSdkRuntime } from "./runtime";
import { usersApi, type UserExport, type UsersApi } from "./user-data";
import { bot, botJobs, type BotApi } from "./bot/plugin";
import type { ConversationsApi } from "./bot/conversations-api";
import type { ScreensApi } from "./bot/screens-api";
import type { SecretsApi } from "./bot/secrets-api";
import type { CheckInsApi, RoutinesApi } from "./bot/routines-api";
import type { TriggersApi } from "./bot/triggers-api";
import type { DemonstrationsApi } from "./bot/demonstrations-api";
import type { HelpersApi } from "./bot/helpers-api";
import type { ReviewsApi } from "./bot/reviews-api";
import type { RulesApi } from "./bot/rules-api";
import { channel, createChannels, noChannels } from "./bot/channels";
import { hintChanged } from "./bot/conversation";
import type { ChannelAdapter, ChannelApi } from "./channel/internal";
import { computerSleepJob, createComputer } from "./computer/internal";
import type { ComputerProvider } from "./computer/internal";
import { models, type ModelsApi, type ModelsOptions, type ModelsPlugin } from "./models/internal";
import type { CoreJobServices, Executor, JobDefinition, JobRunner } from "./runner/internal";
import { createRunner, jobTable, type RunnerApi } from "./runner/internal";

/** Where the RPC calls' errors go, and the SDK's warnings when it has `warn`. */
export type Logger = Pick<Console, "error"> & Partial<Pick<Console, "warn">>;

/** What the `features` slot takes: features built with `defineFeature`. */
export type FeatureEntry = AnyFeature;

/** The `users` slot: what the SDK asks the Host about a user, by id. Users stay opaque ids. */
export type UsersSlot = {
  /**
   * Whether the Host has banned the user (spec #277). A banned owner's Routine fires, Check-in
   * fires, Routine webhooks and inbound email start no Turns; in-process calls are trusted.
   * Unset, nobody is blocked.
   */
  isBlocked?: (userId: string) => boolean | Promise<boolean>;
  /**
   * The user's verified account email, or `null` when they have none: only mail from it reaches
   * their Bots. Unset, none does.
   */
  verifiedEmail?: (userId: string) => Promise<string | null>;
};

/**
 * The factory's options (spec #871): the Bot core is always on, Models are configured in `models`,
 * and infrastructure goes in flat adapter slots, each with a default.
 */
export type BotSdkOptions<Features extends readonly FeatureEntry[] = readonly FeatureEntry[]> = {
  /**
   * The Postgres the SDK keeps its data in: `postgres({ connectionString })`, or
   * `postgres({ pool })` with the Host's own node-postgres-compatible pool (`pg`, Neon serverless).
   * The SDK ends only a pool it opened (on `stop()`), and listens for `error` only on that one.
   */
  database: PostgresDatabase;
  /**
   * The keyring (ADR 0010), at least one secret. The first encrypts Provider and Tool credentials
   * at rest; every entry decrypts, so a key can be added in front of the old one.
   */
  keyEncryptionSecrets: string[];
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
   * Where file bytes are kept (ADR 0015). Defaults to a `botsdk.blob` table in the same database;
   * a Host with object storage passes its store, and then the bytes of files already stored
   * stay where they are.
   */
  blobs?: BlobStore;
  /** What the SDK asks the Host about a user (spec #873). */
  users?: UsersSlot;
  /**
   * The path the HTTP layer is served at (its `basePath`, for example `/api/chat`), under which
   * the live view's links to a Screen point: `<liveViewBase>/screens/…`. Set it to make links
   * with `computer.view` and `demonstrations.view` in a process that serves no HTTP. Unset, the
   * first `createHttpHandler` or `createScreenSocket` made over the instance sets it to its
   * `basePath`, and a link before then throws.
   */
  liveViewBase?: string;
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
   * The Model that reviews each Bot's risky tool calls before they run (Auto-review), a
   * `"provider:model"` id from the Models' list, resolved per user. Unset, or one the user can't
   * use, the Bot's own Model reviews, in a fresh context.
   */
  reviewModel?: string;
  /**
   * Safety settings of Auto-review. `neverAllowed` adds classes of action, in plain language, to
   * the SDK's Never-allowed list: Auto-review blocks them with no Approval offered. The SDK's
   * own classes can't be removed.
   */
  safety?: { neverAllowed?: readonly string[] };
  /**
   * The Host's callbacks into the SDK. Each hook is optional and runs after its change is written,
   * never awaited, at most once and without retries (README, "Host hooks").
   */
  hooks?: HooksOf<[ModelsPlugin]>;
};

export type BotSdk = {
  /** The runner's jobs. */
  runner: RunnerApi;
  /** The core's Models (spec #871): metering, the Quota and the Admin views' usage reads. */
  models: ModelsApi;
  /**
   * The core's Bots (spec #871): the domain methods (spec #873) and `stopTurns` for a Ban.
   */
  bots: BotApi;
  /**
   * The core's Conversations (spec #873): `watch` for a Conversation's change hints and `changes`
   * for what changed since a cursor.
   */
  conversations: ConversationsApi;
  /** The core's Secrets (spec #873): `save`, `list` and `delete`. The value never comes out. */
  secrets: SecretsApi;
  /**
   * The Computer's Screens (spec #873): `view` for a live-view link to a Helper's Screen and
   * `control` to take control or give back.
   */
  computer: ScreensApi;
  /**
   * The core's Routines, Check-ins, Helpers, Demonstrations and Auto-reviews (spec #873), the
   * user's side of each: list, approve, pause, stop, allow and so on, by `userId`.
   */
  routines: RoutinesApi;
  checkIns: CheckInsApi;
  triggers: TriggersApi;
  helpers: HelpersApi;
  demonstrations: DemonstrationsApi;
  reviews: ReviewsApi;
  /** The core's Custom Rules (spec #989): the user's standing instructions for Auto-review. */
  rules: RulesApi;
  /** The core's Channels (spec #871): the inbound handler of each adapter in the channels slot. */
  channels: ChannelApi;
  /**
   * Creates the `botsdk` schema and applies the core's and the enabled features' migrations that
   * aren't applied yet (spec #874). A feature turned off keeps its tables. Run it at deploy time.
   */
  migrate: () => Promise<void>;
  /**
   * Refuses (throws) while the core's or an enabled feature's migrations aren't all applied; then starts the
   * core's parts, in order. `models` refuses with neither `hostProviders` nor `byok` on; the
   * runner starts its job reaper and the jobs runner (ADR 0011).
   */
  start: () => Promise<void>;
  /**
   * Sets `stopping`, stops the core's parts in reverse order, then closes the runtime's
   * connections and ends the pool the SDK opened from a connection string (a Host's own pool is
   * left open). The runner drains its jobs for up to 250 s, then aborts the rest and waits up to
   * 250 s more for their handlers to end. A part whose stop throws doesn't stop the others; its
   * error is rethrown once the runtime closes. Call it on SIGTERM.
   */
  stop: () => Promise<void>;
  /** The core's users (spec #873): `delete` and `export` of a user's data across every part. */
  users: UsersApi;
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
function coreRoutes(exportUser: UsersApi["export"]): Route[] {
  return [
    {
      method: "GET",
      path: "/events",
      handle: (request, { user, sdk }) => handleConversationEvents(request, user, sdk),
    },
    {
      method: "GET",
      path: "/export",
      handle: async (_request, { user }) => exportResponse(await exportUser({ userId: user.id })),
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
    | "parts"
    | "models"
    | "runner"
    | "computer"
    | "bots"
    | "conversations"
    | "secrets"
    | "screens"
    | "routines"
    | "checkIns"
    | "triggers"
    | "helpers"
    | "demonstrations"
    | "reviews"
    | "rules"
    | "channels"
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
 * Bots, and the Channels (with only the email inbound route, answering 404, when their slot isn't
 * set). Models come first, so every other part's `init` finds `sdk.models` set.
 */
export function coreParts(options: BotSdkOptions, modelsPart?: BotSdkPlugin): BotSdkPlugin[] {
  if (!modelsPart && !options.models) {
    throw new Error("Models aren't configured: set the models slot");
  }
  return [
    modelsPart ?? models(options.models),
    bot({ reviewModel: options.reviewModel, neverAllowed: options.safety?.neverAllowed }),
    ...(options.channels
      ? [
          channel({
            adapters: options.channels,
            verifiedEmail: options.users?.verifiedEmail ?? (async () => null),
          }),
        ]
      : [noChannels()]),
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
  const core = parts ?? coreParts(options);
  if (core[0]?.id !== "models") throw new Error("The core's parts must start with Models");
  const features: readonly AnyFeature[] = options.features ?? [];
  // The core services the instance has: a feature's `needs` are checked against them.
  const services = new Set([
    "runner",
    "models",
    "threads",
    ...(options.computer ? ["computer"] : []),
  ]);
  const ids = new Set<string>();
  for (const feature of features) {
    if (ids.has(feature.id)) throw new Error(`Feature "${feature.id}" is enabled twice`);
    ids.add(feature.id);
    checkFeature(feature, services);
  }
  // The core serves its own routes and rules beside its parts', so no part can claim them.
  const own: BotSdkPlugin = {
    id: "core",
    routes: coreRoutes((input) => instance.users.export(input)),
    rateLimits: coreRateLimits,
  };
  const declared = [
    own,
    ...core,
    ...features.map((feature): BotSdkPlugin => ({
      id: feature.id,
      router: featureRouter(feature),
      routes: feature.routes,
    })),
  ];
  const router = mergeRouters(declared);
  const routes = mergeRoutes(declared);
  const ruleDefaults = mergeRateLimits([own, ...core]);

  // Building the context opens nothing: the pool and the runtime connect on first use.
  const sdk = buildContext(options, given) as BotSdkContext;
  const ownsPool = !given.db && !("pool" in options.database);
  // The core services, over the context they belong to, before any part's `init` runs.
  const runner = createRunner(sdk, options.runner, given.jobs);
  sdk.runner = runner.api;
  sdk.computer = options.computer ? createComputer(sdk, options.computer) : null;
  // No Channel besides web, until the channels slot's init sets its adapters.
  sdk.channels = createChannels(sdk, { adapters: [], verifiedEmail: async () => null });
  // The Models' init first, so a feature's context holds them: it reads nothing the parts set.
  const modelsInit = core[0].init?.(sdk);
  const threads: ThreadsService = {
    hintChanged: (conversationId) => hintChanged(sdk, conversationId),
  };
  // Each feature in the Host's order, with the core services it needs.
  const enabled = features.map((feature) => enableFeature(sdk, feature, threads));
  const plugins = [...core, ...enabled.map(featurePlugin)];
  // Every job the runner runs: the core's, each feature's with its context, then the Host's.
  const coreServices: CoreJobServices = { deps: sdk };
  const jobs = jobTable([
    { jobs: [...botJobs, computerSleepJob], services: coreServices },
    ...enabled.map(({ feature, context }) => ({ jobs: feature.jobs ?? [], services: context })),
    { jobs: options.jobs ?? [], services: contextOf(sdk, [], threads) },
  ]);
  const apis = new Map<string, object>();
  sdk.parts = { all: plugins, features: enabled, jobs, apis };
  // In order: the core's parts first, then each feature's API.
  for (const plugin of plugins) {
    const init = plugin === core[0] ? modelsInit : plugin.init?.(sdk);
    apis.set(plugin.id, init?.api ?? {});
  }

  const instance: BotSdk = {
    runner: sdk.runner,
    models: sdk.models,
    bots: sdk.bots,
    conversations: sdk.conversations,
    secrets: sdk.secrets,
    computer: sdk.screens,
    routines: sdk.routines,
    checkIns: sdk.checkIns,
    triggers: sdk.triggers,
    helpers: sdk.helpers,
    demonstrations: sdk.demonstrations,
    reviews: sdk.reviews,
    rules: sdk.rules,
    channels: sdk.channels,
    migrate: () => migrateSchema(options.database, featureMigrations(features)),
    start: async () => {
      await assertMigrated(options.database, featureMigrations(features));
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
      try {
        await options.pubsub?.close?.();
      } catch (error) {
        errors.push(error);
      }
      // The pool the SDK opened from a connection string is its own to end, once, even when stop()
      // overlaps itself; a Host's pool is the Host's.
      if (ownsPool && !sdk.db.$client.ending) await sdk.db.$client.end();
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Several parts failed to stop");
    },
    users: usersApi(sdk),
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
  // What the HTTP layer serves, kept off the instance's typed and enumerable keys.
  const http: HttpParts = { context: sdk, router, routes, rateLimits: ruleDefaults };
  Object.defineProperty(instance, httpPartsKey, { value: http });
  return { instance, context: sdk };
}

/**
 * What `createHttpHandler` serves of an instance: its core context, every part's routers and routes,
 * and the default of each rate-limit rule.
 */
export type HttpParts = {
  context: BotSdkContext;
  router: ReturnType<typeof mergeRouters>;
  routes: readonly Route[];
  rateLimits: Readonly<Record<string, RateLimit>>;
};

// A registered symbol, so a copy of this module in another bundle (the Host's Nitro plugin) finds it.
const httpPartsKey = Symbol.for("@ai-chat/bot-sdk/http");

/** The HTTP parts of an instance `createBotSdk` built; throws for anything else. */
export function httpPartsOf(sdk: BotSdk): HttpParts {
  const parts = (sdk as { [httpPartsKey]?: HttpParts } | null)?.[httpPartsKey];
  if (!parts) throw new Error("createHttpHandler takes an instance that createBotSdk built");
  return parts;
}

/** The core context: the infrastructure from the options, with any `given` part in its place. */
function buildContext(
  options: BotSdkOptions,
  given: GivenContext,
): Omit<BotSdkContext, "runner" | "computer" | "channels" | "parts"> {
  const logger = options.logger ?? console;
  const db = given.db ?? databaseOf(options.database, logger);
  const runtime = given.runtime ?? options.pubsub ?? memoryRuntime();
  const counters = given.counters ?? runtime.counters;
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
    liveView: given.liveView ?? {
      base: options.liveViewBase === undefined ? null : normalizeBasePath(options.liveViewBase),
    },
    isUserBlocked: given.isUserBlocked ?? options.users?.isBlocked ?? (() => false),
    // Set by the Models' init, which runs before every other part's.
    models: modelsUnconfigured,
    // Set by the Bots' init, which the core always runs.
    bots: botsUnconfigured,
    conversations: conversationsUnconfigured,
    secrets: botsStub<SecretsApi>({ save: true, list: true, delete: true }),
    screens: botsStub<ScreensApi>({ view: true, control: true }),
    routines: botsStub<RoutinesApi>({
      list: true,
      approve: true,
      decline: true,
      pause: true,
      resume: true,
      delete: true,
      edit: true,
      rotate: true,
      receiveWebhook: true,
    }),
    checkIns: botsStub<CheckInsApi>({ list: true, cancel: true, edit: true }),
    triggers: botsStub<TriggersApi>({ skip: true }),
    helpers: botsStub<HelpersApi>({ list: true, done: true, stop: true }),
    demonstrations: botsStub<DemonstrationsApi>({
      pause: true,
      resume: true,
      done: true,
      cancel: true,
      view: true,
      steps: true,
    }),
    reviews: botsStub<ReviewsApi>({ list: true, allow: true, deny: true }),
    rules: botsStub<RulesApi>({
      list: true,
      neverAllowed: true,
      create: true,
      update: true,
      delete: true,
      approve: true,
      deny: true,
    }),
  };
}

/** Every name of the Models' API, so the unconfigured stand-in throws on those alone. */
const modelsApiKeys: Record<keyof ModelsApi, true> = {
  list: true,
  imageModel: true,
  setImageModel: true,
  credentials: true,
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

/** Every name of the Conversations' API, so the stand-in throws on those alone. */
const conversationsApiKeys: Record<keyof ConversationsApi, true> = { watch: true, changes: true };

/** The `conversations` service of an instance whose core parts have no `bot()`: reading it throws. */
const conversationsUnconfigured = new Proxy({} as ConversationsApi, {
  get: (_target, key) => {
    if (typeof key === "string" && key in conversationsApiKeys) {
      throw new Error("The Bots aren't enabled: build the SDK with the slots");
    }
    return undefined;
  },
});

/** The stand-in of a Bots namespace on an instance whose core parts have no `bot()`: its methods throw. */
function botsStub<Api extends object>(keys: Record<keyof Api, true>): Api {
  return new Proxy({} as Api, {
    get: (_target, key) => {
      if (typeof key === "string" && key in keys) {
        throw new Error("The Bots aren't enabled: build the SDK with the slots");
      }
      return undefined;
    },
  });
}

/** Every name of the Bots' API, so the stand-in throws on those alone. */
const botApiKeys: Record<keyof BotApi, true> = {
  create: true,
  list: true,
  get: true,
  send: true,
  upload: true,
  stop: true,
  pause: true,
  resume: true,
  reset: true,
  tasks: true,
  warm: true,
  choose: true,
  react: true,
  stopTurns: true,
  reviewModel: true,
  neverAllowed: true,
};
