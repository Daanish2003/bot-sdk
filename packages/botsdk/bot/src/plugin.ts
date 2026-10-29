import type { AnyRouter } from "@orpc/server";

import type { BlobStore, Database } from "./storage";
import type { CounterStore } from "./chat/counters";
import type { EventHooks, HookEmitter } from "./chat/hooks";
import type { PubSub } from "./chat/pubsub";
import type { ChatUser } from "./context";
import type { RateLimit } from "./rate-limits";
import type { BotSdkRuntime } from "./runtime";
import type { EnabledFeature } from "./feature";
import type { BotApi } from "./bot/plugin";
import type { ConversationsApi } from "./bot/conversations-api";
import type { ScreensApi } from "./bot/screens-api";
import type { SecretsApi } from "./bot/secrets-api";
import type { CheckInsApi, RoutinesApi } from "./bot/routines-api";
import type { TriggersApi } from "./bot/triggers-api";
import type { DemonstrationsApi } from "./bot/demonstrations-api";
import type { HelpersApi } from "./bot/helpers-api";
import type { ReviewsApi } from "./bot/reviews-api";
import type { NotificationsApi } from "./bot/notifications-api";
import type { RulesApi } from "./bot/rules-api";
import type { ChannelApi } from "./channel/internal";
import type { ComputerApi } from "./computer/internal";
import type { ModelsApi } from "./models/internal";
import type { JobTable, RunnerApi } from "./runner/internal";

/** What the core gives its parts: the infrastructure and the core services. */
export type BotSdkContext = {
  db: Database;
  blobStore: BlobStore;
  /** What the SDK shares across processes: PubSub and the rate-limit counters. */
  runtime: BotSdkRuntime;
  pubsub: PubSub;
  counters: CounterStore;
  logger: Pick<Console, "error">;
  /** Fires the Host's `hooks`. */
  events: HookEmitter;
  /** The SSRF-guarded `fetch`. */
  fetch: typeof fetch;
  /** The hosts `fetch` may reach although private (`createBotSdk({ fetchAllowHosts })`). */
  fetchAllowHosts: string[];
  clock: () => Date;
  /** `keyEncryptionSecrets` (ADR 0010): the first encrypts, every entry decrypts. */
  keyring: string[];
  /** Set by `stop()`. */
  lifecycle: { stopping: boolean };
  /**
   * The path the live view's links point under (`<base>/screens/…`), without a trailing slash:
   * `createBotSdk`'s `liveViewBase`, else the `basePath` of the first HTTP handler or screen
   * socket made over the instance, or `null` before either.
   */
  liveView: { base: string | null };
  isUserBlocked: (userId: string) => boolean | Promise<boolean>;
  /** The runner (ADR 0011): the background jobs, from the runner slot or the in-process runner. */
  runner: RunnerApi;
  /** Each user's Computer, on the computer slot's provider, or `null` when the slot isn't set. */
  computer: ComputerApi | null;
  /**
   * The core's Models (spec #871), configured by the `models` slot: who pays for a call and with
   * which credentials, the Models a user can pick, metering and the Quota.
   */
  models: ModelsApi;
  /** The core's Bots (spec #871): the Host's handlers and the Ban's stop. */
  bots: BotApi;
  /** The core's Conversations (spec #873): their change hints and change log. */
  conversations: ConversationsApi;
  /** The core's Secrets (spec #873): the user's Secrets, shared by all their Bots. */
  secrets: SecretsApi;
  /** The Computer's Screen methods (spec #873): the live view of a Helper's Screen. */
  screens: ScreensApi;
  /** The core's Routines, Check-ins, Helpers, Demonstrations and Auto-reviews (spec #873). */
  routines: RoutinesApi;
  checkIns: CheckInsApi;
  triggers: TriggersApi;
  helpers: HelpersApi;
  demonstrations: DemonstrationsApi;
  reviews: ReviewsApi;
  /** The core's Custom Rules (spec #989): the user's standing instructions for Auto-review. */
  rules: RulesApi;
  /** The core's notification settings (spec #1024): Quiet hours and where Messages go. */
  notifications: NotificationsApi;
  /**
   * The core's Channels besides web (spec #871), over the channels slot's adapters. With none,
   * every inbound answers 404 and no reply goes out by email.
   */
  channels: ChannelApi;
  /**
   * The instance's parts, for the core's work across them (deletes, exports, a Turn's features):
   * every part in order (the core's, then a plugin for each feature), the enabled features, and
   * the jobs the runner runs: the core's, the features' and the Host's (spec #872).
   */
  parts: {
    all: readonly BotSdkPlugin[];
    features: readonly EnabledFeature[];
    jobs: JobTable;
    /** Every part's API by part id, filled as the parts' `init` runs (spec #873). */
    apis: ReadonlyMap<string, object>;
  };
};

/** A transaction on the core's database. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A plugin's hooks on a Conversation delete (spec #439), called once per set of Conversations on
 * every path that deletes them. `before` runs in the transaction, before the rows go, and returns
 * what it collected; a throw rolls the delete back. `after` runs after the commit with that value;
 * a throw is logged and swallowed. `userId` is `null` only for the Temporary sweep, which spans users.
 */
export type ConversationDeleteHooks<Collected = unknown> = {
  before(
    sdk: BotSdkContext,
    args: { conversationIds: string[]; userId: string | null; tx: Transaction },
  ): Promise<Collected>;
  after(
    sdk: BotSdkContext,
    args: { conversationIds: string[]; userId: string | null; collected: Collected },
  ): Promise<void>;
};

/**
 * A plugin's hooks on a user's delete (`sdk.users.delete`, spec #439). `before` runs in the delete's
 * transaction and returns what it collected; a throw rolls the whole delete back. `after` runs after
 * the commit with that value; a throw is logged and swallowed.
 */
export type UserDeleteHooks<Collected = unknown> = {
  before(sdk: BotSdkContext, args: { userId: string; tx: Transaction }): Promise<Collected>;
  after(sdk: BotSdkContext, args: { userId: string; collected: Collected }): Promise<void>;
};

type RouteArgs<User> = {
  user: User;
  sdk: BotSdkContext;
  /** The `:name` segments of the route's path. */
  params: Record<string, string>;
  /** `basePath` without a trailing slash. */
  basePath: string;
};

/**
 * A non-RPC HTTP route, under `basePath`. A `:name` segment of `path` matches any one segment, and
 * a last `*` segment the rest of the path.
 */
export type Route = {
  method: "GET" | "HEAD" | "POST";
  path: `/${string}`;
} & (
  | {
      /** Served without a signed-in user, before `getUser` runs. */
      public: true;
      handle: (request: Request, args: RouteArgs<null>) => Promise<Response>;
    }
  | {
      public?: false;
      handle: (request: Request, args: RouteArgs<ChatUser>) => Promise<Response>;
    }
);

/**
 * One part of an instance, internal to the SDK: the core's Models, Bots and Channels, and the
 * plugin each feature runs as. `Rule` names its rate-limit rules and `Event` the event hooks it
 * fires; `createHttpHandler`'s `rateLimits` and the root `hooks` are typed by them.
 */
export type BotSdkPlugin<
  Id extends string = string,
  Rule extends string = string,
  Event extends keyof EventHooks = keyof EventHooks,
> = {
  id: Id;
  /** oRPC routers, served under `<basePath>/rpc/<key>`. A key two plugins claim throws. */
  router?: Record<string, AnyRouter>;
  routes?: readonly Route[];
  /** This plugin's rate-limit rules and their defaults; `createHttpHandler`'s `rateLimits` overrides them. */
  rateLimits?: Record<Rule, RateLimit>;
  /** Runs once, in order, when the instance is built. It must open no connection. */
  init?: (sdk: BotSdkContext) => { api?: object } | void;
  /** Runs in order, after the schema check. */
  start?: (sdk: BotSdkContext) => Promise<void>;
  /** Runs in reverse order, after `stopping` is set. */
  stop?: (sdk: BotSdkContext) => Promise<void>;
  /**
   * Re-encrypts this plugin's stored secrets under the keyring's first secret (ADR 0010).
   * `unreadable` counts rows no key can read. `rotateKeys()` sums every plugin's counts.
   */
  rotateKeys?: (sdk: BotSdkContext) => Promise<{ reencrypted: number; unreadable: number }>;
  /** Hooks on deletes of core rows, run by the core's delete (`deleteConversations`). */
  databaseHooks?: { conversation?: { delete?: ConversationDeleteHooks } };
  /**
   * Deletes this plugin's data for a user (`sdk.users.delete`): `before` in the delete's transaction,
   * in reverse order, ahead of the core's Conversation and Attachment deletes; `after`
   * once it commits.
   */
  deleteUser?: UserDeleteHooks;
  /**
   * This plugin's part of a user's export (`sdk.users.export`), read in the export's snapshot `tx`.
   * The core stores it under this plugin's id and holds it as unknown, so the plugin types its own
   * part.
   */
  exportUser?: (sdk: BotSdkContext, userId: string, tx: Transaction) => Promise<object>;
  /** Type only: the event hooks this plugin fires. */
  readonly "~events"?: Event;
};

/** The rate-limit rules the core declares itself, beside the plugins' (spec #439). */
export type CoreRule = "attachmentUpload";

/** The event hooks the core fires itself, beside the plugins' (spec #439). */
export type CoreEvent = "onConversationDeleted";

type RuleOf<Plugin> =
  Plugin extends BotSdkPlugin<string, infer Rule, keyof EventHooks> ? Rule : never;
type EventOf<Plugin> = Plugin extends BotSdkPlugin<string, string, infer Event> ? Event : never;

/** `createHttpHandler`'s `rateLimits`: any core or enabled plugin's rule, overridden or turned off with `false`. */
export type RateLimitsOf<Plugins extends readonly BotSdkPlugin[]> = Partial<
  Record<CoreRule | RuleOf<Plugins[number]>, RateLimit | false>
>;

/** The root `hooks`: the event hooks the core and the enabled plugins fire. */
export type HooksOf<Plugins extends readonly BotSdkPlugin[]> = Pick<
  EventHooks,
  CoreEvent | EventOf<Plugins[number]>
>;

/** The instance's parts, in order: the core's, then a plugin for each feature. */
export function enabledPlugins(sdk: Pick<BotSdkContext, "parts">): readonly BotSdkPlugin[] {
  return sdk.parts.all;
}

/** Every plugin's routers in one, by key. Throws when two plugins claim one key. */
export function mergeRouters(plugins: readonly BotSdkPlugin[]): Record<string, AnyRouter> {
  const merged: Record<string, AnyRouter> = {};
  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    for (const [key, router] of Object.entries(plugin.router ?? {})) {
      const owner = owners.get(key);
      if (owner) {
        throw new Error(`Router key "${key}" is claimed by both "${owner}" and "${plugin.id}"`);
      }
      owners.set(key, plugin.id);
      merged[key] = router;
    }
  }
  return merged;
}

/**
 * Every plugin's routes in one list. Throws when two routes share a method and path, or when a
 * route sits under `/rpc`, where the routers are served.
 */
export function mergeRoutes(plugins: readonly BotSdkPlugin[]): Route[] {
  const owners = new Map<string, string>();
  return plugins.flatMap((plugin) =>
    (plugin.routes ?? []).map((route) => {
      if (route.path === "/rpc" || route.path.startsWith("/rpc/")) {
        throw new Error(`Plugin "${plugin.id}" has a route under /rpc: ${route.path}`);
      }
      const key = `${route.method} ${route.path}`;
      const owner = owners.get(key);
      if (owner) throw new Error(`Route "${key}" is claimed by both "${owner}" and "${plugin.id}"`);
      owners.set(key, plugin.id);
      return route;
    }),
  );
}

/** Every plugin's rate-limit defaults in one, by rule. Throws when two plugins declare one rule. */
export function mergeRateLimits(plugins: readonly BotSdkPlugin[]): Record<string, RateLimit> {
  const merged: Record<string, RateLimit> = {};
  const owners = new Map<string, string>();
  for (const plugin of plugins) {
    for (const [rule, limit] of Object.entries<RateLimit>(plugin.rateLimits ?? {})) {
      const owner = owners.get(rule);
      if (owner) {
        throw new Error(`Rate limit "${rule}" is declared by both "${owner}" and "${plugin.id}"`);
      }
      owners.set(rule, plugin.id);
      merged[rule] = limit;
    }
  }
  return merged;
}

/** `basePath` without a trailing slash; one that doesn't start with "/" throws. */
export function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith("/")) throw new Error(`basePath must start with "/": ${basePath}`);
  return basePath.replace(/\/+$/, "");
}

/**
 * The `:name` segments of `pattern` when `path` matches it, else `null`. A `:name` segment matches
 * one segment that isn't empty. A last `*` segment matches the rest of `path`, one segment or more
 * whose first isn't empty, given as the param `*`.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const expected = pattern.split("/");
  let actual = path.split("/");
  if (expected.at(-1) === "*") {
    if (actual.length < expected.length || !actual[expected.length - 1]) return null;
    actual = [...actual.slice(0, expected.length - 1), actual.slice(expected.length - 1).join("/")];
    expected[expected.length - 1] = ":*";
  }
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index]!;
    if (segment.startsWith(":")) {
      if (!value) return null;
      params[segment.slice(1)] = value;
    } else if (segment !== value) {
      return null;
    }
  }
  return params;
}
