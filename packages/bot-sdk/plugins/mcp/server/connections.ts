import { and, asc, eq, gt, isNotNull, or } from "drizzle-orm";

import { mcpConnection } from "./db/connection";
import {
  decryptCredentials,
  encryptCredentials,
  encryptionKid,
  kidOf,
} from "../../../core/server/credentials/encryption";
import { rotateInPasses } from "../../../core/server/credentials/rotation";
import type { BotSdkContext } from "../../../core/server/plugin";
import type { TokenSet } from "./oauth";
import type { McpServerConfig } from "./servers";

/**
 * A user's Connections to the Host's MCP servers (spec #91, ADR 0010 for their key). A Connection's
 * tokens and its pending sign-in are encrypted; the client only ever sees the summary below.
 */
type Deps = Pick<BotSdkContext, "db" | "keyring">;

export type ConnectionSummary = {
  key: string;
  name: string;
  /** `reconnect`: a row whose tokens no longer decrypt (a key changed, or the row was damaged). */
  state: "connected" | "reconnect" | "disconnected";
  scopes: string[];
};

/** A sign-in is only honoured this long after it began. */
const signInTtlMs = 10 * 60_000;

const tokenOptions = (deps: Deps, userId: string, key: string) => ({
  secrets: deps.keyring,
  kind: "connection" as const,
  context: `${userId}:mcp:${key}`,
});

const pendingOptions = (deps: Deps, userId: string, key: string) => ({
  secrets: deps.keyring,
  kind: "connection" as const,
  context: `${userId}:mcp-pending:${key}`,
});

const splitScopes = (scopes: string | null) => (scopes ?? "").split(" ").filter(Boolean);

/** The tokens a Connection holds, as `saveTokens` stores them. */
export type StoredTokens = {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: string;
};

/** Whether the access token has run out. A token with no expiry never has. */
export const isExpired = (tokens: StoredTokens) =>
  tokens.expiresAt !== undefined && Date.parse(tokens.expiresAt) <= Date.now();

/** The stored tokens of a decrypted Connection, or `null` when it holds no access token. */
function tokensOf(credentials: Record<string, string>): StoredTokens | null {
  const { accessToken, tokenType, refreshToken, expiresAt } = credentials;
  if (!accessToken) return null;
  return {
    accessToken,
    tokenType: tokenType || "Bearer",
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * The user's tokens for one server, with the scopes they were granted: `null` when there is no
 * Connection, or its tokens no longer decrypt.
 */
export async function readTokens(
  deps: Deps,
  userId: string,
  key: string,
): Promise<{ tokens: StoredTokens; scope: string } | null> {
  const [row] = await deps.db
    .select()
    .from(mcpConnection)
    .where(and(eq(mcpConnection.userId, userId), eq(mcpConnection.serverKey, key)));
  if (!row?.encrypted) return null;
  const decrypted = decryptCredentials(row.encrypted, tokenOptions(deps, userId, key));
  if (!decrypted.ok) return null;
  const tokens = tokensOf(decrypted.credentials);
  return tokens ? { tokens, scope: row.scopes ?? "" } : null;
}

/** One entry per server the Host lists, in the Host's order. */
export async function listConnections(
  deps: Deps,
  servers: readonly McpServerConfig[],
  userId: string,
): Promise<ConnectionSummary[]> {
  const rows = await deps.db.select().from(mcpConnection).where(eq(mcpConnection.userId, userId));
  return servers.map(({ key, name }) => {
    const row = rows.find((candidate) => candidate.serverKey === key);
    if (!row?.encrypted) return { key, name, state: "disconnected", scopes: [] };
    const decrypted = decryptCredentials(row.encrypted, tokenOptions(deps, userId, key));
    // Unreadable tokens, or an expired access token with no refresh token left, need a reconnect.
    const tokens = decrypted.ok ? tokensOf(decrypted.credentials) : null;
    const reconnect = !tokens || (isExpired(tokens) && !tokens.refreshToken);
    return {
      key,
      name,
      state: reconnect ? "reconnect" : "connected",
      scopes: splitScopes(row.scopes),
    };
  });
}

/** Records a sign-in in flight: its state (which the callback must echo) and what the callback needs. */
export async function beginSignIn(
  deps: Deps,
  userId: string,
  key: string,
  pending: { state: string; verifier: string; returnTo: string; tokenEndpoint: string },
) {
  const { state, ...rest } = pending;
  const pendingEncrypted = encryptCredentials(
    { ...rest, issuedAt: String(Date.now()) },
    pendingOptions(deps, userId, key),
  );
  await deps.db
    .insert(mcpConnection)
    .values({ userId, serverKey: key, pendingState: state, pendingEncrypted })
    .onConflictDoUpdate({
      target: [mcpConnection.userId, mcpConnection.serverKey],
      set: { pendingState: state, pendingEncrypted, updatedAt: new Date() },
    });
}

/**
 * Takes the sign-in with this `state` for the user, clearing it so it can't be used twice. `null`
 * for an unknown, expired, replayed or unreadable one.
 */
export async function claimSignIn(deps: Deps, userId: string, state: string) {
  const [row] = await deps.db
    .select()
    .from(mcpConnection)
    .where(and(eq(mcpConnection.userId, userId), eq(mcpConnection.pendingState, state)));
  if (!row?.pendingEncrypted) return null;
  const decrypted = decryptCredentials(
    row.pendingEncrypted,
    pendingOptions(deps, userId, row.serverKey),
  );
  if (!decrypted.ok) return null;
  const { verifier, returnTo, tokenEndpoint, issuedAt } = decrypted.credentials;
  const age = Date.now() - Number(issuedAt);
  if (!verifier || !returnTo || !tokenEndpoint || !(age >= 0 && age <= signInTtlMs)) {
    return null;
  }
  // The compare-and-set makes a second, concurrent claim of the same state come back empty.
  const claimed = await deps.db
    .update(mcpConnection)
    .set({ pendingState: null, pendingEncrypted: null })
    .where(
      and(
        eq(mcpConnection.userId, userId),
        eq(mcpConnection.serverKey, row.serverKey),
        eq(mcpConnection.pendingState, state),
      ),
    )
    .returning({ serverKey: mcpConnection.serverKey });
  if (claimed.length === 0) return null;
  return { serverKey: row.serverKey, verifier, returnTo, tokenEndpoint };
}

/** Stores a finished sign-in's tokens, encrypted, with the scopes the server granted. */
export async function saveTokens(deps: Deps, userId: string, key: string, tokens: TokenSet) {
  const stored: Record<string, string> = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
  };
  if (tokens.refreshToken) stored.refreshToken = tokens.refreshToken;
  if (tokens.expiresAt) stored.expiresAt = tokens.expiresAt;
  const encrypted = encryptCredentials(stored, tokenOptions(deps, userId, key));
  await deps.db
    .insert(mcpConnection)
    .values({ userId, serverKey: key, encrypted, scopes: tokens.scope })
    .onConflictDoUpdate({
      target: [mcpConnection.userId, mcpConnection.serverKey],
      set: { encrypted, scopes: tokens.scope, updatedAt: new Date() },
    });
}

/** Removes the user's Connection to one server, its tokens and any sign-in in flight. */
export async function deleteConnection(deps: Deps, userId: string, key: string) {
  await deps.db
    .delete(mcpConnection)
    .where(and(eq(mcpConnection.userId, userId), eq(mcpConnection.serverKey, key)));
}

/**
 * Re-encrypts every Connection's tokens whose key isn't the keyring's first (ADR 0010), in batches
 * ordered by row key. Tokens no key can read stay in place and are counted. A row a concurrent
 * write changed between the read and the update (perhaps an instance still on the old keyring) is
 * caught by another scan (`rotateInPasses`), as for credentials. A pending sign-in is left alone; it
 * expires within minutes.
 */
export async function rotateConnectionKeys(
  deps: Deps,
  { batchSize = 100 }: { batchSize?: number } = {},
): Promise<{ reencrypted: number; unreadable: number }> {
  return rotateInPasses(() => rotateConnectionsOnce(deps, batchSize));
}

/** One scan over every Connection; `raced` counts updates that found the row already changed. */
async function rotateConnectionsOnce(deps: Deps, batchSize: number) {
  const result = { reencrypted: 0, raced: 0, unreadable: 0 };
  const firstKid = encryptionKid(deps.keyring, "connection");
  let after: { userId: string; serverKey: string } | undefined;
  for (;;) {
    const rows = await deps.db
      .select({
        userId: mcpConnection.userId,
        serverKey: mcpConnection.serverKey,
        encrypted: mcpConnection.encrypted,
      })
      .from(mcpConnection)
      .where(
        and(
          isNotNull(mcpConnection.encrypted),
          after &&
            or(
              gt(mcpConnection.userId, after.userId),
              and(
                eq(mcpConnection.userId, after.userId),
                gt(mcpConnection.serverKey, after.serverKey),
              ),
            ),
        ),
      )
      .orderBy(asc(mcpConnection.userId), asc(mcpConnection.serverKey))
      .limit(batchSize);
    for (const row of rows) {
      if (!row.encrypted) continue;
      const options = tokenOptions(deps, row.userId, row.serverKey);
      const decrypted = decryptCredentials(row.encrypted, options);
      if (!decrypted.ok) {
        result.unreadable += 1;
        continue;
      }
      if (kidOf(row.encrypted) === firstKid) continue;
      const updated = await deps.db
        .update(mcpConnection)
        .set({ encrypted: encryptCredentials(decrypted.credentials, options) })
        .where(
          and(
            eq(mcpConnection.userId, row.userId),
            eq(mcpConnection.serverKey, row.serverKey),
            eq(mcpConnection.encrypted, row.encrypted),
          ),
        )
        .returning({ serverKey: mcpConnection.serverKey });
      if (updated.length === 0) result.raced += 1;
      result.reencrypted += updated.length;
    }
    const last = rows.at(-1);
    if (!last || rows.length < batchSize) return result;
    after = { userId: last.userId, serverKey: last.serverKey };
  }
}
