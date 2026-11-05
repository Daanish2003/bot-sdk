import type { FeatureContext } from "@botsdk/bot/feature";

/*
 * The limits on web chat's public routes (ticket #1337). A new session is a new identity, so the
 * per-identity inbound limit doesn't stop a flood, and an `Origin` check stops other sites' pages and
 * no other program: these counters bound that traffic. Each is a fixed window on the SDK's shared
 * `counters`, so they hold across processes when the Host runs Redis. Each answers the seconds to wait
 * once its window is over, for a route to send as `Retry-After`, or null while the hit is allowed.
 */

/** A fixed window: at most `limit` hits per `windowSeconds`. */
type Window = { limit: number; windowSeconds: number };

export const webChatLimits = {
  /** Sessions one IP starts. */
  sessionStartsPerIp: { limit: 10, windowSeconds: 600 },
  /** Messages one session sends. */
  sendsPerSession: { limit: 10, windowSeconds: 60 },
  /** Messages one IP sends, across all its sessions. */
  sendsPerIp: { limit: 30, windowSeconds: 60 },
} satisfies Record<string, Window>;

/**
 * Reads the IP a request came from, which the Host knows and the SDK can't: the socket's address, or
 * a header its own proxy sets. A forwarded header is never read by default, since anyone can send one.
 */
export type ClientIp = (request: Request) => string | null | undefined;

type Counting = Pick<FeatureContext<"counters">, "counters">;

/** Counts a hit on `key`, and returns the seconds to wait once its window is over `rule`. */
async function hitOn({ counters }: Counting, rule: Window, key: string): Promise<number | null> {
  const { count, resetMs } = await counters.hit(key, rule.windowSeconds * 1000);
  return count <= rule.limit ? null : Math.max(1, Math.ceil(resetMs / 1000));
}

/**
 * The IP the Host says a request came from, if it says. Trimmed, lowercased and cut to 64 characters,
 * so a long or oddly cased value neither bloats what counts it nor counts as a new address.
 */
export const clientIpOf = (request: Request, clientIp: ClientIp | undefined) =>
  clientIp?.(request)?.trim().toLowerCase().slice(0, 64);

/**
 * Counts a hit against the request's IP under `prefix`. A Host that gave no `clientIp` has no IP to
 * count, so the hit isn't limited here.
 */
async function limitByIp(
  context: Counting,
  request: Request,
  clientIp: ClientIp | undefined,
  rule: Window,
  prefix: string,
) {
  const ip = clientIpOf(request, clientIp);
  return ip ? hitOn(context, rule, `${prefix}:${ip}`) : null;
}

/** Counts a session start against its IP. */
export const limitSessionStart = (
  context: Counting,
  request: Request,
  clientIp: ClientIp | undefined,
) => limitByIp(context, request, clientIp, webChatLimits.sessionStartsPerIp, "web-chat:start:ip");

/** Counts a send against its IP. Cheap, so it runs before the session is read. */
export const limitSendByIp = (
  context: Counting,
  request: Request,
  clientIp: ClientIp | undefined,
) => limitByIp(context, request, clientIp, webChatLimits.sendsPerIp, "web-chat:send:ip");

/** Counts a send against its session, which is its identity. */
export const limitSendBySession = (context: Counting, identity: string) =>
  hitOn(context, webChatLimits.sendsPerSession, `web-chat:send:session:${identity}`);
