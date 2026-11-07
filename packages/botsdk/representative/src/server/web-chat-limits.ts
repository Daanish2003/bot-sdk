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
  /** Streams one IP opens. What it holds open is capped apart, which opening and closing never reach. */
  streamOpensPerIp: { limit: 120, windowSeconds: 60 },
  /** Codes one session asks for by email (ticket #1350). */
  codeRequestsPerSession: { limit: 5, windowSeconds: 3600 },
  /** Codes one IP asks for, across its sessions. */
  codeRequestsPerIp: { limit: 20, windowSeconds: 3600 },
  /** Codes one session enters. Each code also takes only five tries. */
  codeChecksPerSession: { limit: 10, windowSeconds: 600 },
  /** Codes one IP enters, across its sessions. */
  codeChecksPerIp: { limit: 30, windowSeconds: 600 },
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

/** The eight 16-bit groups of an IPv6 address, or null for anything else. */
function ipv6Groups(address: string): number[] | null {
  const bare = address.replace(/^\[(.*)\]$/, "$1");
  // Only what an address is made of, so nothing else in it can make the URL parse another host.
  if (!/^[0-9a-f:.]+$/.test(bare)) return null;
  let host: string;
  try {
    // URL parsing checks the address and writes it one way, with any IPv4 tail as hex groups.
    host = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head = "", tail] = host.split("::");
  const groups = (part: string) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const front = groups(head);
  if (tail === undefined) return front;
  const back = groups(tail);
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/**
 * The IP the Host says a request came from, as the key it counts under, if the Host says. An IPv4
 * address mapped into IPv6, or translated by a NAT64, is that IPv4 address, and an IPv6 address counts by its /64, which one
 * subscriber holds whole, so a second spelling or another address of the same block is no new client.
 * Anything else is trimmed, lowercased and cut to 64 characters, so it can't bloat what counts it.
 */
export function clientIpOf(request: Request, clientIp: ClientIp | undefined) {
  const ip = clientIp?.(request)?.trim().toLowerCase();
  if (!ip) return ip;
  const groups = ip.includes(":") ? ipv6Groups(ip) : null;
  if (!groups) return ip.slice(0, 64);
  const [a, b, c, d, e, f] = groups;
  // Mapped (::ffff:0:0/96), or translated by a NAT64 (64:ff9b::/96): the visitor is on IPv4.
  const mapped = a === 0 && b === 0 && f === 0xffff;
  const translated = a === 0x64 && b === 0xff9b && f === 0;
  if ((mapped || translated) && c === 0 && d === 0 && e === 0) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

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

/** Counts a stream's opening against its IP. Cheap, so it runs before the session is read. */
export const limitStreamByIp = (
  context: Counting,
  request: Request,
  clientIp: ClientIp | undefined,
) => limitByIp(context, request, clientIp, webChatLimits.streamOpensPerIp, "web-chat:stream:ip");

/** Counts a send against its session, which is its identity. */
export const limitSendBySession = (context: Counting, identity: string) =>
  hitOn(context, webChatLimits.sendsPerSession, `web-chat:send:session:${identity}`);

/** Counts a code request against its IP. Cheap, so it runs before the session is read. */
export const limitCodeRequestByIp = (
  context: Counting,
  request: Request,
  clientIp: ClientIp | undefined,
) => limitByIp(context, request, clientIp, webChatLimits.codeRequestsPerIp, "web-chat:code:ip");

/** Counts a code request against its session. */
export const limitCodeRequestBySession = (context: Counting, identity: string) =>
  hitOn(context, webChatLimits.codeRequestsPerSession, `web-chat:code:session:${identity}`);

/** Counts an entered code against its IP. Cheap, so it runs before the session is read. */
export const limitCodeCheckByIp = (
  context: Counting,
  request: Request,
  clientIp: ClientIp | undefined,
) => limitByIp(context, request, clientIp, webChatLimits.codeChecksPerIp, "web-chat:check:ip");

/** Counts an entered code against its session. */
export const limitCodeCheckBySession = (context: Counting, identity: string) =>
  hitOn(context, webChatLimits.codeChecksPerSession, `web-chat:check:session:${identity}`);
