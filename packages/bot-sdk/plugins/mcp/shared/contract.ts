import { oc, type } from "@orpc/contract";
import { z } from "zod";

/*
 * The `mcp` feature's contract (spec #873): the user's Connections to the Host's MCP servers,
 * served under `<basePath>/rpc/mcp` and implemented by `sdk.mcp`'s methods of the same names.
 * Tokens never leave the server (spec #91). Public interface: the browser client is typed by it,
 * and it changes only with the package's semver.
 */

/** A server the Host offers, and the user's Connection to it. */
export type ConnectionSummary = {
  key: string;
  name: string;
  /** `reconnect`: a row whose tokens no longer decrypt (a key changed, or the row was damaged). */
  state: "connected" | "reconnect" | "disconnected";
  scopes: string[];
};

/** `mcp.disconnect`'s input, besides `userId`. */
export const disconnectInput = z.object({ key: z.string().min(1) });

export const mcpContract = {
  /** Every server the Host offers, with the user's Connection to it. */
  listConnections: oc.output(type<ConnectionSummary[]>()),
  /** Removes the user's Connection to one server: its tokens and any sign-in in flight. */
  disconnect: oc.input(disconnectInput).output(type<void>()),
};

export type McpContract = typeof mcpContract;
