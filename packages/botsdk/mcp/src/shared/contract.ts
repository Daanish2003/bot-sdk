import { oc, type } from "@orpc/contract";

/*
 * The `mcp` feature's contract (spec #873): the user's Connections, served under
 * `<basePath>/rpc/mcp` and implemented by `sdk.mcp`'s methods of the same names. Tokens never
 * leave the server, and connecting and disconnecting are the Host's (ADR 0037). Public interface:
 * the browser client is typed by it, and it changes only with the package's semver.
 */

/** A Connection the Host declares, and its state from the Host's `connection` hook. */
export type ConnectionSummary = {
  key: string;
  name: string;
  /** `reconnect`: linked, but the Host's refresh of its token failed. */
  state: "connected" | "reconnect" | "disconnected";
};

export const mcpContract = {
  /** Every Connection the Host declares, with its state for the user. */
  listConnections: oc.output(type<ConnectionSummary[]>()),
};

export type McpContract = typeof mcpContract;
