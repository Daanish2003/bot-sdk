import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import type { FeatureContext, PublicRoute } from "@botsdk/bot/feature";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { rpcError } from "@botsdk/bot/rpc-error";
import type { Transaction } from "@botsdk/bot/plugin";
import type { WidgetKeyView } from "../shared/contract";
import { signed, signedByKeyring, webChatChannel } from "./customer-proof";
import type { Heard } from "./customers";
import { representativeWidgetKey } from "./db/schema";
import { limitSessionStart, type ClientIp } from "./web-chat-limits";
import { ownedRow } from "./representatives";

/*
 * A Representative's public widget key, and starting a web chat session with it (ticket #1333). A
 * session is a token the server signs with the keyring, with no row behind it: it names its key, a
 * new identity on the web chat Channel, and when it ends. The identity's row is made by the first
 * message it sends, like any new sender's, so a request that only starts a session writes nothing.
 *
 * Reading a token checks its key is still the live one. Rotating changes the key, and disabling is
 * final for that key, so either ends all its sessions for good.
 */

/** How long a session lasts, fixed. A visitor after that starts a new session, as a new identity. */
export const widgetSessionLastsMs = 24 * 60 * 60_000;

/** The Host's check on a session start request: true admits it, false or a throw refuses it. */
export type WidgetSessionCheck = (request: Request) => boolean | Promise<boolean>;

type Context = Pick<FeatureContext, "db">;
type Row = typeof representativeWidgetKey.$inferSelect;

const viewOf = ({ key, allowedOrigins, status }: Row): WidgetKeyView => ({
  key,
  allowedOrigins,
  status,
});

/** A new key: public, but long enough that nobody finds a Representative's line by guessing. */
const newKey = () => randomBytes(24).toString("base64url");

const noKey = () =>
  rpcError("NOT_FOUND", "error.widgetKeyNotFound", "This Representative has no widget key");

/** Changes the owner's key under its Representative's lock, refusing another owner's as not found. */
async function changeKey(
  { db }: Context,
  userId: string,
  id: string,
  change: (tx: Transaction) => Promise<Row[]>,
): Promise<WidgetKeyView> {
  return db.transaction(async (tx) => {
    await ownedRow(tx, userId, id, true);
    const [row] = await change(tx);
    if (!row) throw noKey();
    return viewOf(row);
  });
}

const updateKey = (tx: Transaction, id: string, changes: Partial<Row>) =>
  tx
    .update(representativeWidgetKey)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(representativeWidgetKey.representativeId, id))
    .returning();

export async function getWidgetKey(
  { db }: Context,
  userId: string,
  id: string,
): Promise<WidgetKeyView | null> {
  await ownedRow(db, userId, id);
  const [row] = await db
    .select()
    .from(representativeWidgetKey)
    .where(eq(representativeWidgetKey.representativeId, id));
  return row ? viewOf(row) : null;
}

export async function createWidgetKey(
  { db }: Context,
  userId: string,
  id: string,
): Promise<WidgetKeyView> {
  return db.transaction(async (tx) => {
    await ownedRow(tx, userId, id, true);
    const [row] = await tx
      .insert(representativeWidgetKey)
      .values({ representativeId: id, key: newKey(), allowedOrigins: [], status: "live" })
      .onConflictDoNothing({ target: representativeWidgetKey.representativeId })
      .returning();
    if (!row) {
      throw rpcError(
        "CONFLICT",
        "error.widgetKeyTaken",
        "This Representative already has a widget key",
      );
    }
    return viewOf(row);
  });
}

export const setWidgetKeyOrigins = (
  context: Context,
  userId: string,
  { id, origins }: { id: string; origins: string[] },
) =>
  changeKey(context, userId, id, (tx) =>
    updateKey(tx, id, { allowedOrigins: [...new Set(origins)] }),
  );

export const rotateWidgetKey = (context: Context, userId: string, id: string) =>
  changeKey(context, userId, id, (tx) => updateKey(tx, id, { key: newKey(), status: "live" }));

export const disableWidgetKey = (context: Context, userId: string, id: string) =>
  changeKey(context, userId, id, (tx) => updateKey(tx, id, { status: "disabled" }));

/** The row holding `key`; a rotated or unknown key has none. */
async function rowOfKey({ db }: Context, key: string) {
  const [row] = await db
    .select()
    .from(representativeWidgetKey)
    .where(eq(representativeWidgetKey.key, key));
  return row ?? null;
}

const sessionToken = (
  keyring: readonly string[],
  key: string,
  identity: string,
  expiresAt: Date,
) => {
  const value = `${key}.${identity}.${expiresAt.getTime()}`;
  return `${value}.${signed(keyring[0]!, "widgetSession", value)}`;
};

/** A session its token still vouches for. */
export type WidgetSession = { representativeId: string; heard: Heard; expiresAt: Date };

/**
 * The session a token names, or null for a token that is tampered with, expired, signed outside the
 * keyring, or from a key since rotated or disabled. Every public route a visitor uses after session
 * start goes through this.
 */
export async function readWidgetSession(
  { db, keyring, clock }: Pick<FeatureContext, "db" | "keyring" | "clock">,
  token: string,
): Promise<WidgetSession | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [key, identity, expiry, signature] = parts as [string, string, string, string];
  const value = `${key}.${identity}.${expiry}`;
  if (!signedByKeyring(keyring, "widgetSession", value, signature)) {
    return null;
  }
  const expiresAt = new Date(Number(expiry));
  if (clock() >= expiresAt) return null;
  const row = await rowOfKey({ db }, key);
  if (row?.status !== "live") return null;
  return {
    representativeId: row.representativeId,
    heard: { channel: webChatChannel, externalId: identity },
    expiresAt,
  };
}

/** On what a visitor's page reads: any page may read it, and nobody's should be cached. */
export const widgetResponseHeaders = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
};

/** A visitor's page reads the refusal, and the seconds to wait, whatever site it is on. */
export const tooManyRequests = (retryAfter: number) =>
  Response.json(
    { code: "error.tooManyRequests", params: {} },
    {
      status: 429,
      headers: {
        ...widgetResponseHeaders,
        "access-control-expose-headers": "Retry-After",
        "retry-after": String(retryAfter),
      },
    },
  );

/**
 * The same whatever was wrong, so the route says nothing about which keys exist or what they allow.
 * Any page can read it, so a widget can say a chat can't start. Telling a visitor their chat has
 * ended is for the routes that read a session.
 */
const refused = () =>
  Response.json(
    { code: "error.widgetSessionRefused", params: {} },
    { status: 403, headers: widgetResponseHeaders },
  );

/**
 * Whether the Host's check admits a session start. A check that throws refuses it, and its error is
 * logged, so a broken abuse service fails closed.
 */
async function admitted(
  check: WidgetSessionCheck,
  request: Request,
  logger: Pick<Console, "error">,
): Promise<boolean> {
  try {
    // Only a true admits: a JS Host's truthy value (a raw verifier response, say) refuses.
    return (await check(request)) === true;
  } catch (error) {
    logger.error("The widget session check threw, so the session start was refused", error);
    return false;
  }
}

/**
 * Session start: a POST with no body and the key in the path, which a browser sends across origins
 * with no preflight, naming the page's origin in `Origin`. That header stops other sites' pages, not
 * other programs: session and IP limits are what bound those. The Host's `check`, if it gave one,
 * runs only for a request a live key and an allowed origin already accept, so its service isn't
 * called for the rest.
 */
export const widgetSessionRoutes = (
  check?: WidgetSessionCheck,
  clientIp?: ClientIp,
): PublicRoute<"counters">[] => [
  {
    method: "POST",
    path: "/representative/widget/:key/session",
    handle: async (request, { context, params }) => {
      // First, so a flood costs no key lookup and never reaches the Host's check.
      const waitFor = await limitSessionStart(context, request, clientIp);
      if (waitFor !== null) return tooManyRequests(waitFor);
      const origin = request.headers.get("origin");
      if (origin === null) return refused();
      const row = await rowOfKey(context, params.key ?? "");
      if (row?.status !== "live" || !row.allowedOrigins.includes(origin)) return refused();
      if (check && !(await admitted(check, request, context.logger))) return refused();
      const expiresAt = new Date(context.clock().getTime() + widgetSessionLastsMs);
      return Response.json(
        { token: sessionToken(context.keyring, row.key, uuidv7(), expiresAt), expiresAt },
        {
          headers: {
            "access-control-allow-origin": origin,
            "cache-control": "no-store",
            vary: "Origin",
          },
        },
      );
    },
  },
];
