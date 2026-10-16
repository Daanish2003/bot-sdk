import { z } from "zod";

/**
 * The MCP tools a Conversation has switched on (spec #91), stored as one `jsonb` column on the
 * Conversation. `connections` are the server keys whose tools the Run offers; `allowedTools` are
 * the MCP tool names "Allow for this Conversation" lets run without Approval (#159).
 */
export const conversationToolsSchema = z.object({
  connections: z.array(z.string()),
  allowedTools: z.array(z.string()),
});

export type ConversationTools = z.infer<typeof conversationToolsSchema>;

export const noConversationTools: ConversationTools = { connections: [], allowedTools: [] };
