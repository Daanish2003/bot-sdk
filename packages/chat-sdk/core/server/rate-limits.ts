import type { CounterStore } from "./chat/counters";

/** A fixed window: at most `limit` hits per `windowSeconds`. */
export type RateLimit = { limit: number; windowSeconds: number };

/**
 * What `createChat` takes: each limited action may be overridden, and `false` turns that limit off.
 * Every limit is per user, except `sharedLinkView`, which is per client IP.
 */
export type RateLimits = {
  /** Run starts, per user. */
  runStart?: RateLimit | false;
  /** Attachment uploads, per user. */
  attachmentUpload?: RateLimit | false;
  /** Provider and Tool credential saves (each one runs a check), per user. */
  credentialSave?: RateLimit | false;
  /** Conversation searches, per user. */
  conversationSearch?: RateLimit | false;
  /** Shared link views (the handler's read, not `getSharedConversation`), per client IP. */
  sharedLinkView?: RateLimit | false;
};

export type ResolvedRateLimits = {
  runStart: RateLimit | false;
  attachmentUpload: RateLimit | false;
  credentialSave: RateLimit | false;
  conversationSearch: RateLimit | false;
  sharedLinkView: RateLimit | false;
};

export const defaultRateLimits: ResolvedRateLimits = {
  runStart: { limit: 20, windowSeconds: 60 },
  attachmentUpload: { limit: 30, windowSeconds: 600 },
  credentialSave: { limit: 10, windowSeconds: 60 },
  conversationSearch: { limit: 60, windowSeconds: 60 },
  sharedLinkView: { limit: 60, windowSeconds: 60 },
};

/** The defaults, with each override in place. An override of `undefined` keeps the default. */
export function resolveRateLimits(overrides: RateLimits = {}): ResolvedRateLimits {
  return {
    runStart: overrides.runStart ?? defaultRateLimits.runStart,
    attachmentUpload: overrides.attachmentUpload ?? defaultRateLimits.attachmentUpload,
    credentialSave: overrides.credentialSave ?? defaultRateLimits.credentialSave,
    conversationSearch: overrides.conversationSearch ?? defaultRateLimits.conversationSearch,
    sharedLinkView: overrides.sharedLinkView ?? defaultRateLimits.sharedLinkView,
  };
}

/** The RPC routes (under the handler's `/rpc`) that have a limit, and the limit each one uses. */
export const rpcRateLimits: Record<string, keyof ResolvedRateLimits | undefined> = {
  "/attachment/upload": "attachmentUpload",
  "/credentials/save": "credentialSave",
  "/search/query": "conversationSearch",
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
