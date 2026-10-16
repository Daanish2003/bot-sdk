import type { AnyRouter } from "@orpc/server";

import type { BlobStore } from "./blob/store";
import type { CounterStore } from "./chat/counters";
import type { EventHooks, HookEmitter } from "./chat/hooks";
import type { PubSub } from "./chat/pubsub";
import type { ChatUser } from "./context";
import type { Database } from "./db/index";
import type { RateLimit } from "./rate-limits";
import type { BotSdkRuntime } from "./runtime";

/**
 * Each plugin's API, by plugin id. A plugin adds its own by declaration merging:
 * `declare module "…/plugin" { interface PluginApis { models: ModelsApi } }`.
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- filled by declaration merging
export interface PluginApis {}

/** What the core gives every plugin: the infrastructure, and the other plugins through `plugin(id)`. */
export type BotSdkContext = {
  db: Database;
  blobStore: BlobStore;
  /** Carries Runs across processes (ADR 0006); only the assistant reads its run streams. */
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
  isUserBlocked: (userId: string) => boolean | Promise<boolean>;
  /** Every enabled plugin's rate-limit rules, defaults and the root `rateLimits` merged. */
  rateLimits: Readonly<Record<string, RateLimit | false>>;
  /** Counts a hit on a rule; the seconds to wait once it is over its limit, else `null`. */
  rateLimit: (rule: string, key: string) => Promise<number | null>;
  /** An enabled plugin's API. Throws for a plugin that isn't enabled. */
  plugin: <Id extends keyof PluginApis>(id: Id) => PluginApis[Id];
};

type RouteArgs<User> = {
  user: User;
  sdk: BotSdkContext;
  /** The `:name` segments of the route's path. */
  params: Record<string, string>;
  /** `basePath` without a trailing slash. */
  basePath: string;
};

/** A non-RPC HTTP route, under `basePath`. A `:name` segment of `path` matches any one segment. */
export type Route = {
  method: "GET" | "POST";
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
 * A plugin of the Bot SDK (ADR 0020): a plain object. `Rule` names its rate-limit rules and `Event`
 * the event hooks it fires; the root `rateLimits` and `hooks` options are typed by them.
 */
export type BotSdkPlugin<
  Id extends string = string,
  Rule extends string = string,
  Event extends keyof EventHooks = keyof EventHooks,
> = {
  id: Id;
  /** The ids of the plugins this one calls. `createBotSdk` throws when one isn't enabled. */
  requires?: readonly string[];
  /** oRPC routers, served under `<basePath>/rpc/<key>`. A key two plugins claim throws. */
  router?: Record<string, AnyRouter>;
  routes?: readonly Route[];
  /** This plugin's rate-limit rules and their defaults; the root `rateLimits` overrides them. */
  rateLimits?: Record<Rule, RateLimit>;
  /** Runs once, in dependency order, when the instance is built. It must open no connection. */
  init?: (sdk: BotSdkContext) => { api?: object } | void;
  /** Runs in dependency order, after the schema check. */
  start?: (sdk: BotSdkContext) => Promise<void>;
  /** Runs in reverse dependency order, after `stopping` is set. */
  stop?: (sdk: BotSdkContext) => Promise<void>;
  /**
   * Re-encrypts this plugin's stored secrets under the keyring's first secret (ADR 0010).
   * `unreadable` counts rows no key can read. `rotateKeys()` sums every plugin's counts.
   */
  rotateKeys?: (sdk: BotSdkContext) => Promise<{ reencrypted: number; unreadable: number }>;
  /** Type only: the event hooks this plugin fires. */
  readonly "~events"?: Event;
};

/** The rate-limit rules the core declares itself, beside the plugins' (spec #439). */
export type CoreRule = "attachmentUpload" | "conversationSearch";

/** The event hooks the core fires itself, beside the plugins' (spec #439). */
export type CoreEvent = "onConversationCreated" | "onConversationDeleted";

type RuleOf<Plugin> =
  Plugin extends BotSdkPlugin<string, infer Rule, keyof EventHooks> ? Rule : never;
type EventOf<Plugin> = Plugin extends BotSdkPlugin<string, string, infer Event> ? Event : never;

/** The root `rateLimits`: any core or enabled plugin's rule, overridden or turned off with `false`. */
export type RateLimitsOf<Plugins extends readonly BotSdkPlugin[]> = Partial<
  Record<CoreRule | RuleOf<Plugins[number]>, RateLimit | false>
>;

/** The root `hooks`: the event hooks the core and the enabled plugins fire. */
export type HooksOf<Plugins extends readonly BotSdkPlugin[]> = Pick<
  EventHooks,
  CoreEvent | EventOf<Plugins[number]>
>;

/**
 * The plugins in dependency order: each after the plugins it requires, otherwise as listed.
 * Throws on a duplicate id, a missing requirement or a cycle.
 */
export function orderPlugins<Plugin extends BotSdkPlugin>(plugins: readonly Plugin[]): Plugin[] {
  const byId = new Map<string, Plugin>();
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) throw new Error(`Plugin "${plugin.id}" is enabled twice`);
    byId.set(plugin.id, plugin);
  }
  const ordered: Plugin[] = [];
  const visiting = new Set<string>();
  const visit = (plugin: Plugin) => {
    if (ordered.includes(plugin)) return;
    if (visiting.has(plugin.id)) {
      throw new Error(
        `Plugin "${plugin.id}" is in a requires cycle: ${[...visiting, plugin.id].join(" → ")}`,
      );
    }
    visiting.add(plugin.id);
    for (const id of plugin.requires ?? []) {
      const required = byId.get(id);
      if (!required) {
        throw new Error(`Plugin "${plugin.id}" requires plugin "${id}", which isn't enabled`);
      }
      visit(required);
    }
    visiting.delete(plugin.id);
    ordered.push(plugin);
  };
  for (const plugin of plugins) visit(plugin);
  return ordered;
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

/** The `:name` segments of `pattern` when `path` matches it, else `null`. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const expected = pattern.split("/");
  const actual = path.split("/");
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
