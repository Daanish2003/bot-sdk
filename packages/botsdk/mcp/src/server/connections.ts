import { isAllowListed } from "@botsdk/bot/lib/guarded-fetch";
import type { BotSdkContext } from "@botsdk/bot/plugin";
import type { ConnectionSummary } from "../shared/contract";

export type { ConnectionSummary };

/**
 * One app the Host offers its users a Connection to (`mcp({ connections })`, ADR 0037). The Host
 * runs the sign-in and holds the tokens; the Bot SDK asks for them through the `connection` hook.
 */
export type McpConnection = {
  /** Names the Connection in its tools (`<key>_<tool>`) and in the hook. Letters, digits, `_` and `-`. */
  key: string;
  name: string;
  /** The MCP server the tools come from, sent the Connection's access token as a Bearer token. */
  mcp: {
    /** The server's Streamable HTTP endpoint. HTTPS only. */
    url: string;
    /** Tool names to offer from this server; unset, all of them. */
    tools?: string[];
  };
  /** Tool names that need no approval: `needsApproval` is false on them. */
  approvalFree?: string[];
  /**
   * Tool names that count as read-only in a read-only run (spec #1024), besides the tools the
   * server marks `readOnlyHint: true`. Every other tool, one with no hint included, is refused
   * there.
   */
  readOnlyTools?: string[];
};

/**
 * What the Host's `connection` hook answers for a user's Connection (ADR 0037): its access token,
 * `{ reconnect: true }` when it is linked but its refresh failed, or nothing when it was never
 * linked.
 */
export type ConnectionAnswer = { accessToken: string } | { reconnect: true } | null | undefined;

/** The Host's hook for a user's Connection, by the Connection's key (ADR 0037). */
export type ConnectionHook = (
  userId: string,
  key: string,
) => ConnectionAnswer | Promise<ConnectionAnswer>;

type Deps = Pick<BotSdkContext, "logger">;

const keyPattern = /^[A-Za-z0-9_-]+$/;

/**
 * Throws on a Connection the SDK can't offer: a key that isn't a plain name, a repeated key, or a
 * URL that isn't HTTPS. The test allowance (`allowHosts`, `createBotSdk({ fetchAllowHosts })`) lets
 * a listed host be plain HTTP, and only that host.
 */
export function checkConnections(
  connections: readonly McpConnection[],
  allowHosts: readonly string[] = [],
): void {
  const keys = new Set<string>();
  for (const connection of connections) {
    if (!keyPattern.test(connection.key)) {
      throw new Error(`A Connection key must be letters, digits, "_" or "-": "${connection.key}"`);
    }
    if (keys.has(connection.key))
      throw new Error(`Two Connections share the key "${connection.key}"`);
    keys.add(connection.key);
    let url: URL;
    try {
      url = new URL(connection.mcp.url);
    } catch {
      throw new Error(`Connection "${connection.key}" has no valid MCP server URL`);
    }
    const plainHttpAllowed = url.protocol === "http:" && isAllowListed(url, allowHosts);
    if (url.protocol !== "https:" && !plainHttpAllowed) {
      throw new Error(
        `Connection "${connection.key}" must use an HTTPS URL, got ${connection.mcp.url}`,
      );
    }
  }
}

/**
 * The hook's answer for one of the user's Connections, or `null` without a hook. A failing hook
 * is logged and taken as no answer, so one broken Connection leaves the others usable.
 */
export async function askConnection(
  deps: Deps,
  hook: ConnectionHook | undefined,
  userId: string,
  key: string,
): Promise<ConnectionAnswer> {
  if (!hook) return null;
  try {
    return await hook(userId, key);
  } catch (error) {
    deps.logger.error("The Host's connection hook failed", { key, error });
    return null;
  }
}

/** The access token in a hook's answer, or `null` when the Connection can't be used. */
export const accessTokenOf = (answer: ConnectionAnswer): string | null =>
  answer && "accessToken" in answer ? answer.accessToken : null;

/** One entry per Connection the Host declares, in the Host's order, with its state from the hook. */
export async function listConnections(
  deps: Deps,
  connections: readonly McpConnection[],
  hook: ConnectionHook | undefined,
  userId: string,
): Promise<ConnectionSummary[]> {
  return Promise.all(
    connections.map(async ({ key, name }): Promise<ConnectionSummary> => {
      const answer = await askConnection(deps, hook, userId, key);
      const state = accessTokenOf(answer)
        ? "connected"
        : answer && "reconnect" in answer
          ? "reconnect"
          : "disconnected";
      return { key, name, state };
    }),
  );
}
