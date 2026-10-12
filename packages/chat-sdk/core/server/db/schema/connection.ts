import { primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { chatSchema } from "./chat-schema";

/**
 * A user's OAuth sign-in to one Host MCP server (a Connection, spec #91). One row per user and
 * server key. A row holds a pending sign-in while the redirect is out, tokens once it finishes,
 * or both while a sign-in is pending again.
 */
export const mcpConnection = chatSchema.table(
  "mcp_connection",
  {
    /** The Host's user id, with no foreign key, as everywhere in the `chat` schema. */
    userId: text("user_id").notNull(),
    /** The `key` of the Host's `mcpServers` entry. */
    serverKey: text("server_key").notNull(),
    /** The token set, AES-256-GCM encrypted under the Connection key (ADR 0010). `null` until connected. */
    encrypted: text("encrypted"),
    /** The scopes the server granted, space-separated as OAuth sends them. Not secret. */
    scopes: text("scopes"),
    /** The `state` of the sign-in in flight, which the callback must echo. `null` when none is pending. */
    pendingState: text("pending_state"),
    /** The PKCE verifier, return path and token endpoint of that sign-in, encrypted (ADR 0010). */
    pendingEncrypted: text("pending_encrypted"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.serverKey] })],
);
