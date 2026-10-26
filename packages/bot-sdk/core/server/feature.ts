import type { AnyRouter } from "@orpc/server";
import type { AnyServerTool, ModelMessage } from "@tanstack/ai";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import { schema as coreTables } from "./storage";
import type { Database } from "./storage";
import type { BotSdk } from "./create-chat";
import type { BotSdkContext, BotSdkPlugin, Route, Transaction } from "./plugin";
import type { ComputerApi } from "../../plugins/computer/server/internal";
import type { EnqueueOptions, JobDefinition } from "../../plugins/runner/server/internal";

/*
 * Features (spec #871, ADR 0029): optional capabilities beside the Bot core, written against
 * `defineFeature` alone. The core calls a feature; a feature never calls another, never adds
 * columns to a core table, and gets only the core services it declares in `needs`.
 */

/** The core services a feature may declare in `needs`. */
export type CoreService = "computer";

type Services = { computer: ComputerApi };

/** What the core gives every feature, plus the services it declared in `needs`, non-optional. */
export type FeatureContext<Needs extends CoreService = never> = {
  db: Database;
  logger: Pick<Console, "error">;
  clock: () => Date;
  /** The guarded `fetch`: it refuses private addresses and plain HTTP unless `fetchAllowHosts` lists the host. */
  fetch: BotSdkContext["fetch"];
  /** The `host` or `host:port` entries the guarded `fetch` may reach (a test-only config). */
  fetchAllowHosts: BotSdkContext["fetchAllowHosts"];
  /** The keyring (ADR 0010) a feature encrypts its secrets under: the first encrypts, every entry decrypts. */
  keyring: BotSdkContext["keyring"];
  /** The runner's jobs: queue one of the feature's `jobs` in the caller's transaction. */
  jobs: {
    enqueueIn: <P>(
      tx: Transaction,
      job: Pick<JobDefinition<P>, "name" | "payload">,
      payload: P,
      options?: EnqueueOptions,
    ) => Promise<string>;
    /** Claims due jobs now; call it once the transaction that queued them has committed. */
    wake: () => void;
  };
} & Pick<Services, Needs>;

/** The Turn a feature's `tools` and `afterTurn` are called for. */
export type FeatureTurn = { id: string; userId: string; botId: string; conversationId: string };

/**
 * The Turn a feature's `tools` are read for, with the section the feature gave its Prompt start
 * (or an away Summary's): null when it gave none.
 */
export type FeatureToolTurn = FeatureTurn & { section: string | null };

/**
 * What the core gives `tools` for a Turn (or a Helper), when the tools are read for one. It is
 * absent when only their definitions are read (a Summary written while the user is away).
 */
export type FeatureToolKit = {
  /** Aborts when the Turn ends: whatever the feature opened for its tools closes then. */
  signal: AbortSignal;
  /**
   * Lists once, as the Turn's recorded activity: a replay reads what its attempt listed, and
   * only a live Turn calls `list`.
   */
  record: <T>(list: () => Promise<T>) => Promise<T>;
  /** The names the Turn's other tools have: a tool named like one is left out. */
  taken: ReadonlySet<string>;
  /** Masks the user's Secrets in a text; reads them on each call. */
  secretMask: () => Promise<(text: string) => string>;
  /**
   * A call on the user's Computer, as tool call `toolCallId` of the tool `name` (list the name
   * in `computerTools`): the Turn's own Computer call, which is recorded and re-run after a crash,
   * stopped by a Stop and the time limit, masks Secrets, cuts a long result, and tells the Bot of a
   * rebuild of its Computer in the result. A failed wake or operation is its `{ error }`.
   */
  computerCall: <T extends object>(
    name: string,
    toolCallId: string | undefined,
    operate: (
      computer: ReturnType<ComputerApi["forUser"]>,
      live: { signal?: AbortSignal; deadline?: Date },
    ) => Promise<T>,
  ) => Promise<T | { error: string }>;
};

/** What a feature's `tools` gives: its tools, and for a Turn that lists them, what it says of a missing one. */
export type FeatureTools =
  | AnyServerTool[]
  | {
      tools: AnyServerTool[];
      /** The error for a tool of the feature that isn't among `tools` this Turn, else `undefined`. */
      missing?: (name: string) => string | undefined;
      /**
       * The names of the tools that make their own live call through `kit.computerCall`: the core
       * doesn't wrap them in a live request of its own.
       */
      computerTools?: readonly string[];
    };

/** What `prompt` is called with: the Turn, and what the Bot has seen of the feature's section. */
export type FeaturePromptTurn = FeatureTurn & {
  /**
   * The feature's section as the Bot's Prompt start holds it, or `null` before the Bot has one, or
   * when it was built without this section.
   */
  built: string | null;
  /**
   * Every Change note the Bot's Turns were told since its Prompt start was built, oldest first,
   * every feature's and the core's. What the Bot has seen is `built` plus the feature's own notes
   * among them.
   */
  told: readonly string[];
  /** When the Turn started (for a Summary written while away, now): what ages and days count from. */
  startedAt: Date;
  /**
   * The Bot's Turns since its Prompt start was built, oldest first: the Change notes each was told
   * and what it did (its transcript), for a feature to count what the Bot did itself as seen.
   */
  earlier: ReadonlyArray<{ notes: readonly string[]; transcript: readonly ModelMessage[] }>;
  /** Aborts on a Stop or the time limit: whatever the feature reads for its section stops then. */
  signal: AbortSignal;
  /**
   * Masks the user's Secrets in a text, as a Turn's Computer reads are masked: a feature masks what
   * it read before it builds its section and Change notes from it. An away Summary's leaves the
   * text as it is.
   */
  mask: (text: string) => string;
};

/**
 * A feature's part of the Prompt start: its `section`, which the Prompt start keeps as it was
 * built, and the Change notes that tell the Bot what changed since what it has seen (`built` and
 * `told`). The core tells them as given; a `null` section still tells its notes.
 */
export type FeaturePrompt = {
  section: string | null;
  changeNotes?: string[];
  /**
   * A line for the Bot's environment, in the first message of its Prompt start (for example
   * "Memory: on."). Told even when `section` is null.
   */
  environment?: string;
};

/**
 * A feature, as `defineFeature` takes it. Every part is optional but `id`, which names its API on
 * the SDK, its Prompt start section and its part of a user's export.
 */
export type FeatureDefinition<
  Id extends string = string,
  Needs extends CoreService = never,
  Api extends object = object,
> = {
  id: Id;
  /** The core services the feature uses. The factory throws when one isn't configured. */
  needs?: readonly Needs[];
  /**
   * The feature's own tables. Foreign keys into core tables are allowed; a table named like a core
   * table (which would add columns to it) makes the factory throw.
   */
  schema?: Record<string, PgTable>;
  /** User-scoped methods: each takes the user's id. The Host calls them as `sdk.<id>.<method>`. */
  api?: (context: FeatureContext<Needs>) => Api;
  /**
   * The tools the feature adds to a Turn. Deferred: the Prompt start lists them by name. Each call
   * is a live request of the Turn's loop; a tool with `needsApproval` is Auto-reviewed (spec #691)
   * instead of asked of the user. With a `kit`, a feature may list tools from the outside world.
   */
  tools?: (
    turn: FeatureToolTurn,
    context: FeatureContext<Needs>,
    kit?: FeatureToolKit,
  ) => FeatureTools | Promise<FeatureTools>;
  /**
   * Whether its tools are Connector tools: the Change notes say a Connection, not a deploy, added
   * or changed them.
   */
  connectorTools?: boolean;
  /**
   * Whether a Demonstration teaches this feature (Skills): the core offers the Bot `watch_user`
   * while an enabled feature says so.
   */
  demonstrations?: boolean;
  /** The feature's section of the Prompt start, and its Change notes, as a Turn starts. */
  prompt?: (
    turn: FeaturePromptTurn,
    context: FeatureContext<Needs>,
  ) => Promise<FeaturePrompt | null>;
  /**
   * Runs in the transaction that ends each Turn, in a savepoint of its own: a throw is logged and
   * undoes only the feature's writes.
   */
  afterTurn?: (tx: Transaction, turn: FeatureTurn, context: FeatureContext<Needs>) => Promise<void>;
  /**
   * The jobs the feature queues, built with `defineJob` (spec #872). Each one's context has the
   * feature's, with the services in `needs`. A job name can be listed once per instance.
   */
  // oxlint-disable-next-line typescript/no-explicit-any -- each job has its own payload
  jobs?: readonly JobDefinition<any, FeatureContext<Needs>>[];
  /** The feature's part of a user's delete and export (`sdk.users.delete`, `sdk.users.export`). */
  userData?: {
    delete?: {
      /** In the delete's transaction, before the core's rows go; its result reaches `after`. */
      before: (tx: Transaction, userId: string, context: FeatureContext<Needs>) => Promise<unknown>;
      /** Once the delete commits; a throw is logged. */
      after?: (userId: string, collected: unknown, context: FeatureContext<Needs>) => Promise<void>;
    };
    /** Read in the export's snapshot; stored under the feature's id. */
    export?: (tx: Transaction, userId: string, context: FeatureContext<Needs>) => Promise<object>;
  };
  /** Non-RPC routes, under `basePath`, until spec 3 replaces them. They get the whole core context. */
  routes?: Route[];
  /** Re-encrypts what the feature stores under the keyring's first secret (`sdk.rotateKeys`). */
  rotateKeys?: (
    context: FeatureContext<Needs>,
  ) => Promise<{ reencrypted: number; unreadable: number }>;
  /**
   * oRPC routers, served under `<basePath>/rpc/<key>` beside the core's. Until spec 3 replaces
   * them with contracts; their procedures still reach the SDK through `context.sdk`.
   */
  router?: Record<string, AnyRouter>;
};

const brand = Symbol("botSdkFeature");

/** A feature, as `defineFeature` returns it. */
export type Feature<
  Id extends string = string,
  Needs extends CoreService = CoreService,
  Api extends object = object,
> = FeatureDefinition<Id, Needs, Api> & { readonly [brand]: true };

/** Any feature: its callbacks take a context with every service, whatever it needs. */
export type AnyFeature = Feature<string, CoreService, object>;

/**
 * Defines a feature (spec #871): one object literal. `needs` is const-typed, so the services it
 * names arrive non-optional in every callback's context, and no other service does.
 */
export function defineFeature<
  const Id extends string,
  const Needs extends CoreService = never,
  Api extends object = object,
>(definition: FeatureDefinition<Id, Needs, Api>): Feature<Id, Needs, Api> {
  return { ...definition, [brand]: true } as Feature<Id, Needs, Api>;
}

export function isFeature(value: unknown): value is AnyFeature {
  return typeof value === "object" && value !== null && brand in value;
}

/**
 * The Prompt start sections the core writes itself, the core's export keys, the built-in plugin
 * ids, `then` and `toJSON`.
 */
const reservedIds = new Set([
  // An instance with a `then` would be awaited as a promise, and one with `toJSON` serialised by it.
  "then",
  "toJSON",
  "rules",
  "computer",
  "routines",
  "first_message",
  "version",
  "exportedAt",
  "core",
  "bot",
  "models",
  "runner",
  "channel",
  "channels",
]);

/**
 * The names the SDK instance has, or must not have, which a feature's API can't take. Typed
 * against `BotSdk`, so a new namespace on the instance fails to compile until it is listed here.
 */
const instanceKeys: Record<keyof BotSdk, true> = {
  runner: true,
  models: true,
  bots: true,
  conversations: true,
  secrets: true,
  computer: true,
  routines: true,
  checkIns: true,
  helpers: true,
  demonstrations: true,
  reviews: true,
  channels: true,
  migrate: true,
  start: true,
  stop: true,
  users: true,
  rotateKeys: true,
};

/** The core's tables, by name: a feature declares none of them. */
const coreTableNames = new Set(
  Object.values(coreTables).flatMap((value) =>
    is(value, PgTable) ? [getTableConfig(value).name] : [],
  ),
);

const serviceNames: Record<CoreService, string> = { computer: "the Computer" };

/**
 * Throws when a feature's id is reserved, a table of its schema is a core table, or a service it
 * needs isn't configured (`services` holds the instance's core services).
 */
export function checkFeature(feature: AnyFeature, services: ReadonlySet<string>): void {
  if (
    reservedIds.has(feature.id) ||
    Object.hasOwn(instanceKeys, feature.id) ||
    // A name every object inherits (`__proto__`, `constructor`) isn't the feature's own key.
    feature.id in Object.prototype
  ) {
    throw new Error(`Feature id "${feature.id}" is reserved by the core`);
  }
  for (const table of Object.values(feature.schema ?? {})) {
    const { name } = getTableConfig(table);
    if (coreTableNames.has(name)) {
      throw new Error(
        `Feature "${feature.id}" declares the core table "${name}": a feature adds tables, never columns on the core's`,
      );
    }
  }
  for (const need of (feature.needs ?? []) as CoreService[]) {
    if (!services.has(need)) {
      throw new Error(
        `Feature "${feature.id}" needs ${serviceNames[need]}, which isn't configured: set the ${need} slot`,
      );
    }
  }
}

/** An enabled feature, with the context the core calls it with. */
export type EnabledFeature = {
  feature: AnyFeature;
  /** Holds the services the feature needs; the types promise every one, as `AnyFeature`'s do. */
  context: FeatureContext<CoreService>;
};

/** The instance's enabled features, in the order the Host listed them. */
export function enabledFeatures(sdk: Pick<BotSdkContext, "parts">): readonly EnabledFeature[] {
  return sdk.parts.features;
}

/** Whether an enabled feature gives Connector tools (`mcp`). */
export const hasConnectorFeature = (sdk: Pick<BotSdkContext, "parts">): boolean =>
  enabledFeatures(sdk).some(({ feature }) => feature.connectorTools);

/** A feature, enabled on `sdk`: its context holds the core services it needs. */
export function enableFeature(sdk: BotSdkContext, feature: AnyFeature): EnabledFeature {
  return { feature, context: contextOf(sdk, feature.needs ?? []) };
}

const coreContext = Symbol("coreContext");

/**
 * The whole core context behind a feature's context, or a job context that spreads one: for the
 * SDK's own Memory feature, whose job still reads the core's Models and Bots. Never public.
 */
export function coreContextOf(context: object): BotSdkContext {
  const sdk = (context as { [coreContext]?: BotSdkContext })[coreContext];
  if (!sdk) throw new Error("Not a feature's context");
  return sdk;
}

/** The context the core gives a feature (or the Host's jobs) that needs `needs`. */
export function contextOf(
  sdk: BotSdkContext,
  needs: readonly CoreService[],
): FeatureContext<CoreService> {
  const base: FeatureContext & { [coreContext]: BotSdkContext } = {
    [coreContext]: sdk,
    db: sdk.db,
    logger: sdk.logger,
    clock: sdk.clock,
    fetch: sdk.fetch,
    fetchAllowHosts: sdk.fetchAllowHosts,
    keyring: sdk.keyring,
    jobs: {
      enqueueIn: (tx, job, payload, options) =>
        sdk.runner.enqueueIn(tx, job.name, payload, options),
      wake: () => sdk.runner.wake(),
    },
  };
  return {
    ...base,
    ...(needs.includes("computer") && { computer: sdk.computer }),
  } as FeatureContext<CoreService>;
}

/**
 * The part an enabled feature runs as: its `init` builds the feature's API, and its routes,
 * routers, key rotation, delete and export are the instance's.
 */
export function featurePlugin({ feature, context }: EnabledFeature): BotSdkPlugin {
  const { userData } = feature;
  const remove = userData?.delete;
  const exportPart = userData?.export;
  return {
    id: feature.id,
    router: feature.router,
    routes: feature.routes,
    init: () => ({ api: feature.api?.(context) ?? {} }),
    ...(feature.rotateKeys && { rotateKeys: () => feature.rotateKeys!(context) }),
    ...(remove && {
      deleteUser: {
        before: (_sdk, { tx, userId }) => remove.before(tx, userId, context),
        after: async (_sdk, { userId, collected }) => {
          await remove.after?.(userId, collected, context);
        },
      },
    }),
    ...(exportPart && { exportUser: (_sdk, userId, tx) => exportPart(tx, userId, context) }),
  };
}

/** An enabled feature's API, as `sdk.<id>` serves it: what its procedures call (spec #873). */
export function featureApi<Api extends object>(sdk: Pick<BotSdkContext, "parts">, id: string): Api {
  const api = sdk.parts.apis.get(id);
  if (!api) throw new Error(`Feature "${id}" is not enabled`);
  return api as Api;
}

/** The Host's typed access to each feature's API: `sdk.<id>`. */
export type FeatureApis<Entries extends readonly unknown[]> = {
  [F in Extract<Entries[number], AnyFeature> as F["id"]]: F extends {
    api?: (context: never) => infer Api;
  }
    ? Api
    : never;
};
