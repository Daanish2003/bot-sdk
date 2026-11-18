import type { AnyServerTool } from "@tanstack/ai";
import { and, asc, eq, lt, ne } from "drizzle-orm";

import { defineFeature } from "@botsdk/bot/feature";
import { bot, botTurn } from "@botsdk/bot/storage";
import {
  checkConnections,
  connectionStates,
  listConnections,
  untilAborted,
  type ConnectionHook,
  type ConnectionSummary,
  type McpConnection,
} from "./connections";
import { connectorTools } from "./connector-tools";
import { mcpContract } from "../shared/contract";
import { openMcpTools } from "./tools";

export type McpOptions = {
  /**
   * The apps the Host offers its users Connections to (ADR 0037), each with its tools' MCP server
   * (Streamable HTTP over HTTPS only).
   */
  connections?: McpConnection[];
  /**
   * How the Bot SDK learns a user's Connection: its access token, `{ reconnect: true }` or nothing.
   * The Host runs the sign-in, stores and refreshes the tokens. Without it, nothing is connected.
   */
  connection?: ConnectionHook;
};

/** The `mcp` feature's API (`sdk.mcp`): a user's Connections as tools. */
export type McpApi = {
  /** The user's state for each Connection the Host declares, in the Host's order (spec #873). */
  listConnections: (input: { userId: string }) => Promise<ConnectionSummary[]>;
  /** The Connections the Host declares, by key and name: what a tool named `<key>_<tool>` belongs to. */
  servers: ReadonlyArray<{ key: string; name: string }>;
  forUser: (userId: string) => {
    /**
     * The tools of the user's connected Connections, named `<key>_<tool>`, with their clients open
     * until `signal` aborts. A Connection whose server is down, or that the hook gives no token
     * for, is skipped.
     */
    tools: (options: { signal: AbortSignal }) => Promise<AnyServerTool[]>;
  };
};

/**
 * The `mcp` feature (ADR 0027, ADR 0037): the Connections the Host declares, their state from the
 * Host's `connection` hook (the `mcp` contract) and their tools. A Host turns it on with
 * `mcp({ connections, connection })` in `features`.
 */
export function mcp(options: McpOptions = {}) {
  const connections = options.connections ?? [];
  const hook = options.connection;
  return defineFeature({
    id: "mcp",
    connectorTools: true,
    contract: mcpContract,
    api: (context): McpApi => {
      // At construction, so a misconfigured Connection fails the Host's boot (spec #91).
      checkConnections(connections, context.fetchAllowHosts);
      return {
        listConnections: ({ userId }) => listConnections(context, connections, hook, userId),
        servers: connections.map(({ key, name }) => ({ key, name })),
        forUser: (userId) => ({
          tools: ({ signal }) => openMcpTools(context, connections, hook, userId, signal),
        }),
      };
    },
    // Listed by a Turn, never when only the definitions are read: the next Turn notes them added.
    tools: async (turn, context, kit) => {
      if (!kit) return [];
      return connectorTools({
        servers: connections,
        open: (signal) => openMcpTools(context, connections, hook, turn.userId, signal),
        ...kit,
      });
    },
    // The first Connection reaches each Bot in its next Turn's Change notes (spec #1024). The
    // section is what the Prompt start saw of it, so "none yet" in it and a Connection now is news,
    // and so is a Bot's first-ever Turn, whose user already connected. A Bot with earlier Turns
    // whose Prompt start lacks the section (the Host turned the feature on since) isn't told.
    prompt: async (turn, context) => {
      // Raced against the signal: a Stop or the time limit doesn't wait for a slow hook.
      const states = await untilAborted(
        connectionStates(context, connections, hook, turn.userId),
        turn.signal,
      );
      if (!states) throw turn.signal.reason;
      const { summaries, unsure } = states;
      const connected = summaries.filter(({ state }) => state === "connected");
      // A Bot that saw a Connection keeps seeing one while the hook fails or asks for a reconnect,
      // so a new Prompt start doesn't make the first-Connection note news again.
      if (connected.length === 0 && unsure && turn.built === connectedSection) {
        return { section: connectedSection };
      }
      const section =
        connected.length > 0
          ? connectedSection
          : connections.length > 0
            ? noConnectionSection
            : null;
      if (
        (turn.built !== null && turn.built !== noConnectionSection) ||
        connected.length === 0 ||
        turn.told.includes(firstConnectionNote(true)) ||
        turn.told.includes(firstConnectionNote(false))
      ) {
        return { section };
      }
      if (turn.built === null) {
        const [earlier] = await context.db
          .select({ id: botTurn.id })
          .from(botTurn)
          .where(
            and(
              eq(botTurn.botId, turn.botId),
              ne(botTurn.id, turn.id),
              lt(botTurn.startedAt, turn.startedAt),
            ),
          )
          .limit(1);
        if (earlier) return { section };
      }
      const [first] = await context.db
        .select({ id: bot.id })
        .from(bot)
        .where(eq(bot.userId, turn.userId))
        .orderBy(asc(bot.createdAt), asc(bot.id))
        .limit(1);
      return { section, changeNotes: [firstConnectionNote(first?.id === turn.botId)] };
    },
  });
}

const noConnectionSection = "Connections: the user has not connected any app yet.";
const connectedSection = "Connections: the user has connected an app.";

/** The Change note that tells a Bot its user gained their first Connection (spec #1024). */
const firstConnectionNote = (firstBot: boolean) =>
  "The user connected their first Connection (an app you can use through connector tools). " +
  (firstBot
    ? "You are their first Bot: offer them the Morning brief and the Watch now, as your rules say."
    : "You are not their first Bot: set up a Morning brief or Watch only if the user asks.");
