import { isLiveDemonstration } from "@botsdk/client/bot/demonstration";
import { screensPath } from "@botsdk/client/bot/helper";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { WebSocket } from "undici";

import { bot, botDemonstration, botHelper } from "../../../../core/server/storage";
import type { BotSdkContext } from "../../../../core/server/plugin";
import { rpcError } from "../../../../core/server/rpc-error";
import {
  activityHeartbeatMs,
  ComputerOperationError,
  type ScreenControl,
  ScreenNotOpenError,
} from "../../../computer/server/internal";
import { computerOf } from "../agent-loop";
import { helperStoppedError } from "./hand-off";

/**
 * How long a live-view link opens the Screen (#597): a page and its socket must start within it,
 * and a socket already open stays open.
 */
export const viewTokenTtlMs = 10 * 60_000;

/** The key a view token is signed with, derived from one keyring secret (ADR 0010). */
const viewKeys = new Map<string, Buffer>();
const viewKey = (secret: string) => {
  let key = viewKeys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "", "ai-chat screen view", 32));
    viewKeys.set(secret, key);
  }
  return key;
};

const signature = (secret: string, payload: string) =>
  createHmac("sha256", viewKey(secret)).update(payload).digest();

/** What holds a Screen: a Computer-use Helper, or a Demonstration (spec #713). */
export type ScreenHolder = { helperId: string } | { demonstrationId: string };

type View = { holder: ScreenHolder; userId: string; expires: number };

/**
 * A view token: the Helper or Demonstration, its user and the expiry, signed with the keyring's
 * first secret. It is the live view's only authentication, so it is never stored.
 */
function mintViewToken(sdk: BotSdkContext, { holder, userId }: Omit<View, "expires">): string {
  const [secret] = sdk.keyring;
  if (secret === undefined) throw new Error("The keyring holds no secret");
  const expires = sdk.clock().getTime() + viewTokenTtlMs;
  const held = "helperId" in holder ? { h: holder.helperId } : { d: holder.demonstrationId };
  const payload = Buffer.from(JSON.stringify({ ...held, u: userId, e: expires })).toString(
    "base64url",
  );
  return `${payload}.${signature(secret, payload).toString("base64url")}`;
}

/** The view a token names, when any keyring secret signed it and it hasn't expired; else null. */
function verifyViewToken(sdk: BotSdkContext, token: string): View | null {
  const [payload, signed, ...rest] = token.split(".");
  if (!payload || !signed || rest.length > 0) return null;
  const given = Buffer.from(signed, "base64url");
  const valid = sdk.keyring.some((secret) => {
    const expected = signature(secret, payload);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!valid) return null;
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (
    typeof claims !== "object" ||
    claims === null ||
    !("u" in claims && typeof claims.u === "string") ||
    !("e" in claims && typeof claims.e === "number")
  ) {
    return null;
  }
  if (claims.e <= sdk.clock().getTime()) return null;
  const holder =
    "h" in claims && typeof claims.h === "string"
      ? { helperId: claims.h }
      : "d" in claims && typeof claims.d === "string"
        ? { demonstrationId: claims.d }
        : null;
  if (!holder) return null;
  return { holder, userId: claims.u, expires: claims.e };
}

/**
 * The Screen a live Helper or Demonstration of the user's holds, with its Bot (whose Chrome profile
 * it runs), or `"not-found"` for none of theirs, or `"stopped"` for one that ended or holds no
 * Screen.
 */
async function heldScreen(
  sdk: BotSdkContext,
  userId: string,
  holder: ScreenHolder,
): Promise<{ slot: number; botId: string } | "not-found" | "stopped"> {
  if ("demonstrationId" in holder) {
    const [row] = await sdk.db
      .select({
        state: botDemonstration.state,
        screen: botDemonstration.screen,
        botId: botDemonstration.botId,
      })
      .from(botDemonstration)
      .where(
        and(eq(botDemonstration.id, holder.demonstrationId), eq(botDemonstration.userId, userId)),
      );
    if (!row) return "not-found";
    if (!isLiveDemonstration(row.state)) return "stopped";
    return { slot: row.screen, botId: row.botId };
  }
  const { helperId } = holder;
  const [row] = await sdk.db
    .select({ status: botHelper.status, screen: botHelper.screen, botId: botHelper.botId })
    .from(botHelper)
    .innerJoin(bot, eq(bot.id, botHelper.botId))
    .where(and(eq(botHelper.id, helperId), eq(bot.userId, userId)));
  if (!row) return "not-found";
  if (row.screen === null || !["running", "waiting"].includes(row.status)) return "stopped";
  return { slot: row.screen, botId: row.botId };
}

/** `heldScreen`, with its refusals as the router's errors. */
async function ownedScreen(sdk: BotSdkContext, userId: string, holder: ScreenHolder) {
  const screen = await heldScreen(sdk, userId, holder);
  if ("demonstrationId" in holder) {
    if (screen === "not-found") {
      throw rpcError("NOT_FOUND", "error.demonstrationNotFound", "Demonstration not found");
    }
    if (screen === "stopped") {
      throw rpcError("CONFLICT", "error.demonstrationEnded", demonstrationEndedError);
    }
    return screen;
  }
  if (screen === "not-found") {
    throw rpcError("NOT_FOUND", "error.helperNotFound", "Helper not found");
  }
  if (screen === "stopped") throw rpcError("CONFLICT", "error.helperStopped", helperStoppedError);
  return screen;
}

/**
 * Where the live view's links point, `<liveViewBase>/screens`. Throws while the instance has no
 * link base (no `liveViewBase`, and no HTTP handler or screen socket yet), since a link would lead
 * nowhere.
 */
function screensBase(sdk: BotSdkContext): string {
  const { base } = sdk.liveView;
  if (base === null) {
    throw new Error(
      "The live view's links need a base: set createBotSdk's liveViewBase, or call createHttpHandler or createScreenSocket first",
    );
  }
  return screensPath(base);
}

/** What a link to an ended Demonstration's Screen is refused with. */
export const demonstrationEndedError = "This Demonstration has ended.";

/**
 * `computer.view` (#597): a fresh live-view link to the Screen of one of the user's live Helpers,
 * or live Demonstrations (`demonstrations.view`, spec #713), a path under the HTTP layer's
 * `<basePath>/screens` that
 * opens its noVNC page through the proxy. It wakes the Computer and reopens the Screen when it isn't
 * open (after a rebuild). It leaves the Screen's control as it is: a Helper's Screen opens
 * view-only, and only Take control changes that, while a Demonstration's is the user's to drive, so
 * one it reopens gets control back. Neither the traffic token nor the Screen's own token is in it.
 */
export async function screenView(
  sdk: BotSdkContext,
  userId: string,
  holder: ScreenHolder,
): Promise<{ url: string }> {
  const { slot, botId } = await ownedScreen(sdk, userId, holder);
  const computer = computerOf(sdk, userId);
  const urls = await computer.screenUrls(slot).catch(async (caught: unknown) => {
    // Not open: a rebuild lost it, so it opens afresh on the Bot's profile.
    if (!(caught instanceof ComputerOperationError && caught.cause instanceof ScreenNotOpenError)) {
      throw caught;
    }
    await computer.openScreen(slot, botId);
    if ("demonstrationId" in holder) await computer.setScreenControl(slot, "control");
    return computer.screenUrls(slot);
  });
  // The proxy goes on from these, not an address from before a reopen.
  rememberScreenUrls(sdk, userId, slot, urls);
  const base = `${screensBase(sdk)}/${mintViewToken(sdk, { holder, userId })}`;
  const page = new URL(urls.novnc.url);
  const query = new URLSearchParams(page.search);
  // noVNC opens its socket at this path of the page's own host: the proxy's.
  query.set("path", `${base.slice(1)}/websockify`);
  return { url: `${base}${page.pathname}?${query}` };
}

/** Take control and give back (#597): switches the Screen's x11vnc to `mode`. */
export async function screenControl(
  sdk: BotSdkContext,
  userId: string,
  helperId: string,
  mode: ScreenControl,
): Promise<void> {
  const { slot } = await ownedScreen(sdk, userId, { helperId });
  await computerOf(sdk, userId).setScreenControl(slot, mode);
}

/** Where a proxied request goes: the Screen's noVNC, and the headers that let it through. */
type Upstream = {
  userId: string;
  holder: ScreenHolder;
  /** The proxy's path the request's path is under: `<screens base>/<view token>/`. */
  base: string;
  /** The noVNC page's directory, which `base` stands for. */
  directory: string;
  /** The request's path after its token, with its query, under the noVNC page's directory. */
  url: string;
  /** Whether that path is websockify's, the socket's. */
  isSocket: boolean;
  /** websockify's socket with the Screen's token, as the page's own link would open it. */
  socketUrl: string;
  /** Every header of the noVNC endpoint: the traffic token, and whatever routes to the sandbox and port. */
  headers: Record<string, string>;
};

/**
 * How long a Screen's noVNC address is reused across the requests of one page load, so its many
 * files don't each ask the provider (and wake the Computer) again.
 */
const screenUrlsCacheMs = 30_000;

type ScreenUrls = Awaited<ReturnType<ReturnType<typeof computerOf>["screenUrls"]>>;
// Per database, which the router's and the Host handler's contexts share.
const screenUrlsCache = new WeakMap<
  BotSdkContext["db"],
  Map<string, { urls: Promise<ScreenUrls>; until: number }>
>();

function cacheOf(sdk: BotSdkContext) {
  let cache = screenUrlsCache.get(sdk.db);
  if (!cache) {
    cache = new Map();
    screenUrlsCache.set(sdk.db, cache);
  }
  return cache;
}

function rememberScreenUrls(sdk: BotSdkContext, userId: string, slot: number, urls: ScreenUrls) {
  cacheOf(sdk).set(`${userId}:${slot}`, {
    urls: Promise.resolve(urls),
    until: sdk.clock().getTime() + screenUrlsCacheMs,
  });
}

/** `screenUrls` of the user's Screen `slot`, reused for `screenUrlsCacheMs`. */
function cachedScreenUrls(sdk: BotSdkContext, userId: string, slot: number) {
  const cache = cacheOf(sdk);
  const key = `${userId}:${slot}`;
  const now = sdk.clock().getTime();
  for (const [stale, entry] of cache) if (entry.until <= now) cache.delete(stale);
  const cached = cache.get(key);
  if (cached) return cached.urls;
  const urls = computerOf(sdk, userId).screenUrls(slot);
  cache.set(key, { urls, until: now + screenUrlsCacheMs });
  // A failure isn't kept: the next request asks again.
  urls.catch(() => cache.delete(key));
  return urls;
}

/**
 * Whether the path segments after a view token name a file under noVNC's directory: no empty
 * segment but the last, and none that decodes to `.`, `..` or a separator, any of which could climb
 * out of the directory or name another host.
 */
function isFilePath(segments: string[]): boolean {
  return segments.every((segment, index) => {
    if (segment === "") return index === segments.length - 1;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return decoded !== "." && decoded !== ".." && !/[/\\]/.test(decoded);
  });
}

/**
 * The upstream of a request under `screens` (`<basePath>/screens`), or the Response that refuses it: 403 without a
 * valid view token, 400 for a path that would leave noVNC's directory, 404 once its Helper ended or
 * holds no Screen.
 */
async function upstreamOf(
  sdk: BotSdkContext,
  request: Request,
  screens: string,
): Promise<Upstream | Response> {
  const { pathname, search } = new URL(request.url);
  const [token = "", ...rest] = pathname.startsWith(`${screens}/`)
    ? pathname.slice(screens.length + 1).split("/")
    : [];
  const view = verifyViewToken(sdk, token);
  if (!view || rest.length === 0) return new Response(null, { status: 403 });
  if (!isFilePath(rest)) return new Response(null, { status: 400 });
  const screen = await heldScreen(sdk, view.userId, view.holder);
  if (typeof screen === "string") return new Response(null, { status: 404 });
  const urls = await cachedScreenUrls(sdk, view.userId, screen.slot);
  const page = new URL(urls.novnc.url);
  // Relative to the page's directory, so a provider URL with a path prefix keeps it.
  const directory = new URL(".", page);
  const url = new URL(`${rest.join("/")}${search}`, directory);
  // The traffic token goes only to the noVNC endpoint, never another host or path.
  if (url.origin !== directory.origin || !url.pathname.startsWith(directory.pathname)) {
    return new Response(null, { status: 400 });
  }
  const socket = new URL(page.searchParams.get("path") ?? "websockify", directory);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  return {
    userId: view.userId,
    holder: view.holder,
    base: `${screens}/${token}/`,
    directory: directory.href,
    url: url.href,
    isSocket: rest.join("/") === "websockify",
    socketUrl: socket.href,
    headers: urls.novnc.headers,
  };
}

/** The response headers the proxy passes on; the body is decoded, so its encoding isn't. */
const passedHeaders = ["content-type", "cache-control", "etag", "last-modified"];

/**
 * What the proxy adds to every page response. The sandbox serves these files, so they run in an
 * opaque origin (`sandbox allow-scripts`) rather than the Host's, and can't reach its session; that
 * makes the page's own scripts and data cross-origin, which the view token in the path, not a
 * cookie, already authorizes.
 */
const addedHeaders = {
  "content-security-policy": "sandbox allow-scripts",
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
};

/**
 * An in-memory `localStorage` and `sessionStorage`, run before noVNC's own scripts (#606). The
 * sandbox (`sandbox allow-scripts`) gives a page an opaque origin, where reading either throws a
 * SecurityError and noVNC never starts. Its settings then live only as long as the page.
 */
const storageShim = `<script>(function(){for(const name of["localStorage","sessionStorage"]){const data=new Map();Object.defineProperty(window,name,{configurable:true,value:{get length(){return data.size},key:function(i){return Array.from(data.keys())[i]??null},getItem:function(k){k=String(k);return data.has(k)?data.get(k):null},setItem:function(k,v){data.set(String(k),String(v))},removeItem:function(k){data.delete(String(k))},clear:function(){data.clear()}}})}})()</script>`;

/** `html` with the storage shim first in its `<head>` (or first of all, with no `<head>`). */
function withStorageShim(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head) return storageShim + html;
  const end = head.index + head[0].length;
  return html.slice(0, end) + storageShim + html.slice(end);
}

/**
 * The live view's page proxy: a GET under `<screens>/<view token>/` is fetched from the
 * Screen's noVNC with the traffic token added, so the token never reaches the browser.
 */
export async function handleScreenRequest(
  sdk: BotSdkContext,
  request: Request,
  screens: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  try {
    const upstream = await upstreamOf(sdk, request, screens);
    if (upstream instanceof Response) return upstream;
    const response = await fetch(upstream.url, {
      method: request.method,
      headers: upstream.headers,
      redirect: "manual",
    });
    const headers = new Headers(addedHeaders);
    for (const name of passedHeaders) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    // A redirect within noVNC's directory goes on through the proxy; any other is dropped.
    const location = response.headers.get("location");
    if (location !== null) {
      const target = new URL(location, upstream.url).href;
      if (target.startsWith(upstream.directory)) {
        headers.set("location", upstream.base + target.slice(upstream.directory.length));
      }
    }
    // An HTML page gets the storage shim; every other file passes through unchanged.
    const isHtml = (headers.get("content-type") ?? "").toLowerCase().startsWith("text/html");
    if (isHtml && request.method === "GET" && response.ok) {
      return new Response(withStorageShim(await response.text()), {
        status: response.status,
        headers,
      });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (caught) {
    sdk.logger.error("The live view's proxy couldn't reach the Screen", caught);
    return new Response(null, { status: 502 });
  }
}

/**
 * The Host's WebSocket peer, as far as the proxy uses it: crossws's `Peer` (Nitro's
 * `defineWebSocketHandler`) fits, and so does any adapter with the same three members.
 */
export type ScreenPeer = {
  context: Record<string, unknown>;
  send: (data: Uint8Array | string) => unknown;
  close: (code?: number, reason?: string) => unknown;
};

/** A message from the browser, as crossws's `Message` gives it. */
export type ScreenMessage = { uint8Array: () => Uint8Array };

/**
 * The live view's socket proxy as WebSocket hooks in crossws's shape, which the Host mounts at
 * `<screens>/<view token>/websockify`: `upgrade` refuses a request without a valid view token
 * by throwing a Response (403, or 404 once its Helper ended), and each open socket is joined to the
 * Screen's websockify with the traffic token and the Screen's token added. While it is open, it
 * counts as Computer activity every `activityHeartbeatMs`, and closes once its Helper ended.
 */
export type ScreenSocketHooks = {
  upgrade: (request: Request) => Promise<{ protocol?: string; context: Record<string, unknown> }>;
  open: (peer: ScreenPeer) => void;
  message: (peer: ScreenPeer, message: ScreenMessage) => void;
  close: (peer: ScreenPeer) => void;
};

/** One proxied socket, kept in its peer's context. */
type ScreenLink = {
  userId: string;
  holder: ScreenHolder;
  url: string;
  protocols: string[];
  headers: Record<string, string>;
  upstream?: WebSocket;
  /** What the browser sent before the Screen's socket opened. */
  pending: Uint8Array[];
  heartbeat?: ReturnType<typeof setInterval>;
  closed: boolean;
};

const linkOf = (peer: ScreenPeer) => peer.context.screenLink as ScreenLink;

/** Stops a link's heartbeat and closes both of its sockets, once. */
function closeLink(link: ScreenLink, peer: ScreenPeer) {
  if (link.closed) return;
  link.closed = true;
  clearInterval(link.heartbeat);
  link.upstream?.close();
  peer.close();
}

export function screenSocketHooks(sdk: BotSdkContext, screens: string): ScreenSocketHooks {
  return {
    upgrade: async (request) => {
      const upstream = await upstreamOf(sdk, request, screens).catch((caught: unknown) => {
        sdk.logger.error("The live view's proxy couldn't reach the Screen", caught);
        return new Response(null, { status: 502 });
      });
      if (upstream instanceof Response) throw upstream;
      if (!upstream.isSocket) {
        throw new Response(null, { status: 404 });
      }
      // noVNC asks for websockify's `binary` subprotocol, which the browser wants echoed.
      const offered = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((protocol) => protocol.trim());
      const protocols = offered.includes("binary") ? ["binary"] : [];
      const link: ScreenLink = {
        userId: upstream.userId,
        holder: upstream.holder,
        url: upstream.socketUrl,
        protocols,
        headers: upstream.headers,
        pending: [],
        closed: false,
      };
      return { ...(protocols[0] && { protocol: protocols[0] }), context: { screenLink: link } };
    },
    open: (peer) => {
      const link = linkOf(peer);
      const upstream = new WebSocket(link.url, {
        protocols: link.protocols,
        headers: link.headers,
      });
      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        for (const data of link.pending.splice(0)) upstream.send(data);
      };
      upstream.onmessage = (event) => {
        peer.send(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
      };
      upstream.onclose = () => closeLink(link, peer);
      upstream.onerror = () => closeLink(link, peer);
      link.upstream = upstream;
      const computer = computerOf(sdk, link.userId);
      void computer.heartbeat();
      // Each beat checks the holder first: its socket closes once it ended or gave up its Screen.
      const beat = async () => {
        const screen = await heldScreen(sdk, link.userId, link.holder);
        if (typeof screen === "string") closeLink(link, peer);
        else await computer.heartbeat();
      };
      link.heartbeat = setInterval(() => {
        beat().catch((caught: unknown) => {
          sdk.logger.error("The live view's heartbeat failed", caught);
        });
      }, activityHeartbeatMs);
      // A socket left open must not keep the process alive on its own.
      link.heartbeat.unref?.();
    },
    message: (peer, message) => {
      const link = linkOf(peer);
      if (link.closed) return;
      const data = message.uint8Array();
      if (link.upstream?.readyState === WebSocket.OPEN) link.upstream.send(data);
      else link.pending.push(data);
    },
    close: (peer) => closeLink(linkOf(peer), peer),
  };
}
