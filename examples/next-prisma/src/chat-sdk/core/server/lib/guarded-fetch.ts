import dns from "node:dns";
import net, { type LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";
import { Agent } from "undici";

/** Every address a hostname resolves to. Production uses the system resolver. */
export type Resolver = (hostname: string) => Promise<string[]>;

export type GuardedFetchOptions = {
  /** `https` refuses plain HTTP (MCP servers). `http-and-https` allows both (`fetch_url`). */
  schemes: "https" | "http-and-https";
  resolve?: Resolver;
  /**
   * Test seam: the address a checked address is actually dialed at. Production leaves it out,
   * so the socket connects to the address that was checked.
   */
  dial?: (address: string) => string;
  /** Redirect hops followed before the request fails (default 5). */
  maxRedirects?: number;
  /**
   * Test-only (`createChat({ fetchAllowHosts })`). `host` or `host:port` entries the guard reaches
   * over plain HTTP and at any address, the port too when given. Any other host is checked as
   * usual, and a listed host on an unlisted port is refused.
   */
  allowHosts?: string[];
};

/** A request reached a private, reserved or otherwise non-public address. */
export class BlockedAddressError extends Error {
  readonly address: string;

  constructor(address: string, hostname: string) {
    super(`Refused ${hostname}: ${address} is not a public address`);
    this.name = "BlockedAddressError";
    this.address = address;
  }
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const systemResolve: Resolver = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

/** True only for addresses in the global unicast range. Refuses loopback, private, CGNAT, link-local, ULA and the rest. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.process(address).range() === "unicast";
}

/**
 * A `fetch` that refuses non-public addresses and checks every redirect hop. The guard runs
 * inside the socket's DNS lookup: a name is resolved once, every address it returns is checked,
 * and the connection goes to one of those checked addresses. A second resolution never happens,
 * so DNS rebinding can't swap in a private address between the check and the connect.
 */
export function createGuardedFetch(options: GuardedFetchOptions): typeof globalThis.fetch {
  const { schemes, resolve = systemResolve, dial = (address) => address } = options;
  const maxRedirects = options.maxRedirects ?? 5;
  const allowed = parseAllowHosts(options.allowHosts ?? []);
  const allowedNames = new Set(allowed.map((entry) => entry.hostname));
  const dispatcher = new Agent({
    connect: { lookup: pinnedLookup(resolve, dial, allowedNames) },
  });

  return async (input, init) => {
    const request = new Request(input, init);
    let url = new URL(request.url);
    let method = request.method;
    let headers = request.headers;
    let body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;

    for (let hops = 0; ; hops++) {
      assertAllowed(url, schemes, allowed);
      let response: Response;
      try {
        response = await globalThis.fetch(url, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: request.signal,
          dispatcher,
        } as RequestInit);
      } catch (caught) {
        throw blockedCause(caught) ?? caught;
      }

      if (!redirectStatuses.has(response.status)) return response;
      const location = response.headers.get("location");
      if (location === null) return response;
      await response.body?.cancel();
      if (hops >= maxRedirects) throw new Error(`Stopped after ${maxRedirects} redirects`);

      url = new URL(location, url);
      if (response.status === 303 || (method === "POST" && response.status < 307)) {
        method = "GET";
        body = undefined;
        headers = new Headers(headers);
        headers.delete("content-type");
      }
    }
  };
}

type AllowedHost = { hostname: string; port: string | null };

/** `host` (any port) or `host:port`; a port of `""` is the scheme's default port. */
function parseAllowHosts(entries: string[]): AllowedHost[] {
  return entries.map((entry) => {
    const text = entry.trim();
    const url = new URL(`http://${text}`);
    if (url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
      throw new Error(`An allowed host is a host or host:port, not "${entry}"`);
    }
    return { hostname: url.hostname, port: /:\d*$/.test(text) ? url.port : null };
  });
}

/**
 * True when the test allowance lists `url`'s host and port (any port when the entry has none).
 * Plain HTTP to a listed host is the only thing it lets past a check that wants HTTPS (MCP servers).
 */
export function isAllowListed(url: URL, allowHosts: readonly string[]): boolean {
  return parseAllowHosts([...allowHosts]).some(
    (entry) => entry.hostname === url.hostname && (entry.port === null || entry.port === url.port),
  );
}

function assertAllowed(
  url: URL,
  schemes: GuardedFetchOptions["schemes"],
  allowed: AllowedHost[],
): void {
  const listed = allowed.find(
    (entry) => entry.hostname === url.hostname && (entry.port === null || entry.port === url.port),
  );
  if (!listed && allowed.some((entry) => entry.hostname === url.hostname)) {
    throw new Error(`Refused ${url.host}: only the listed ports of ${url.hostname} are allowed`);
  }
  const protocols = schemes === "https" ? ["https:"] : ["http:", "https:"];
  if (!protocols.includes(url.protocol)) {
    const named = schemes === "https" ? "HTTPS" : "HTTP and HTTPS";
    throw new Error(`Only ${named} URLs are allowed, not ${url.protocol}`);
  }
  if (listed) return;
  // A literal address never reaches the socket's lookup, so it is checked here. The WHATWG URL
  // parser has already written odd IPv4 notations (decimal, octal, hex, short) in dotted form.
  const literal = literalAddress(url.hostname);
  if (literal !== undefined && !isPublicAddress(literal)) {
    throw new BlockedAddressError(literal, url.hostname);
  }
}

function literalAddress(hostname: string): string | undefined {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return net.isIP(bare) === 0 ? undefined : bare;
}

function pinnedLookup(
  resolve: Resolver,
  dial: (address: string) => string,
  allowedNames: Set<string>,
): LookupFunction {
  return (hostname, options, callback) => {
    const fail = (error: Error) => callback(error, "", 4);
    resolve(hostname).then((addresses) => {
      // `assertAllowed` has already checked the port of a listed host's request.
      const blocked = allowedNames.has(hostname)
        ? undefined
        : addresses.find((address) => !isPublicAddress(address));
      if (blocked !== undefined) return fail(new BlockedAddressError(blocked, hostname));

      const dialed = addresses.map((address) => dial(address));
      const [first] = dialed;
      if (first === undefined) return fail(new Error(`No address for ${hostname}`));
      if (options.all) {
        return callback(
          null,
          dialed.map((address) => ({ address, family: familyOf(address) })),
        );
      }
      callback(null, first, familyOf(first));
    }, fail);
  };
}

function familyOf(address: string): number {
  return net.isIPv6(address) ? 6 : 4;
}

/** The guard's own error, when `fetch failed` wraps it as a cause. */
function blockedCause(error: unknown): BlockedAddressError | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof BlockedAddressError) return current;
    current = current.cause;
  }
  return undefined;
}
