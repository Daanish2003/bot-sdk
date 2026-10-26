import type { CounterStore } from "./chat/counters";

/** A fixed window: at most `limit` hits per `windowSeconds`. */
export type RateLimit = { limit: number; windowSeconds: number };

/**
 * What `createHttpHandler` takes: each limited action may be overridden, and `false` turns that limit off.
 * Every limit is per user.
 */
export type RateLimits = {
  /** File uploads (Knowledge and the files a user sends their Bot), per user. */
  attachmentUpload?: RateLimit | false;
  /** Provider and Tool credential saves (each one runs a check), per user. */
  credentialSave?: RateLimit | false;
};

export type ResolvedRateLimits = {
  attachmentUpload: RateLimit | false;
  credentialSave: RateLimit | false;
};

export const defaultRateLimits: Record<keyof ResolvedRateLimits, RateLimit> = {
  attachmentUpload: { limit: 30, windowSeconds: 600 },
  credentialSave: { limit: 10, windowSeconds: 60 },
};

/** The defaults, with each override in place. An override of `undefined` keeps the default. */
export function resolveRateLimits(overrides: RateLimits = {}): ResolvedRateLimits {
  return {
    attachmentUpload: overrides.attachmentUpload ?? defaultRateLimits.attachmentUpload,
    credentialSave: overrides.credentialSave ?? defaultRateLimits.credentialSave,
  };
}

/** The RPC routes (under the handler's `/rpc`) that have a limit, and the limit each one uses. */
export const rpcRateLimits: Record<string, keyof ResolvedRateLimits | undefined> = {
  // Knowledge uploads and the files a user sends their Bot share one bucket (specs #737, #801).
  "/knowledge/upload": "attachmentUpload",
  "/knowledge/uploadDocument": "attachmentUpload",
  "/bots/upload": "attachmentUpload",
  "/models/credentials/save": "credentialSave",
};

/**
 * Counts one hit against a limit and returns the seconds to wait (for `Retry-After`) once the
 * window's count passes the limit, or `null` while the hit is allowed.
 */
export async function rateLimitedFor(
  counters: CounterStore,
  rule: RateLimit | false,
  key: string,
): Promise<number | null> {
  if (rule === false) return null;
  const { count, resetMs } = await counters.hit(key, rule.windowSeconds * 1000);
  if (count <= rule.limit) return null;
  return Math.max(1, Math.ceil(resetMs / 1000));
}
