import { getTableConfig, text } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  botsdkSchema,
  assertNoClashes,
  type NamedPluginSchema,
  conversation,
  message,
  type ConversationRow,
  type MessageRow,
} from "@botsdk/bot/storage";

const empty = { tables: {}, enums: {} };

describe("composing the `botsdk` schema", () => {
  it("throws, naming both plugins and the table, when two plugins declare the same table", () => {
    const widget = () => botsdkSchema.table("widget", { id: text().primaryKey() });
    const schemas: NamedPluginSchema[] = [
      { id: "alpha", schema: { ...empty, tables: { widget: widget() } } },
      { id: "beta", schema: { ...empty, tables: { widget: widget() } } },
    ];

    expect(() => assertNoClashes(schemas)).toThrow(/alpha.*beta.*widget/);
  });

  it("throws, naming both plugins and the enum, when two plugins declare the same enum", () => {
    const schemas: NamedPluginSchema[] = ["alpha", "beta"].map((id) => ({
      id,
      schema: { ...empty, enums: { mood: botsdkSchema.enum("mood", ["up", "down"]) } },
    }));

    expect(() => assertNoClashes(schemas)).toThrow(/alpha.*beta.*mood/);
  });

  it("throws when a plugin declares a table named like a core table", () => {
    const schemas: NamedPluginSchema[] = [
      {
        id: "alpha",
        schema: { ...empty, tables: { mine: botsdkSchema.table("message", { id: text() }) } },
      },
    ];

    expect(() => assertNoClashes(schemas)).toThrow(/core.*alpha.*message/);
  });

  it("has only the core's columns and indexes on conversation and message", () => {
    const conversationConfig = getTableConfig(conversation);
    const messageConfig = getTableConfig(message);

    expect(conversationConfig.columns.map((c) => c.name).sort()).toEqual([
      "active_leaf_id",
      "created_at",
      "id",
      "kind",
      "last_message_at",
      "last_seq",
      "title",
      "updated_at",
      "user_id",
    ]);
    expect(conversationConfig.indexes.map((i) => i.config.name)).toEqual([
      "conversation_user_id_last_message_at_idx",
    ]);
    expect(messageConfig.columns.map((c) => c.name).sort()).toEqual([
      "conversation_id",
      "created_at",
      "error",
      "error_reason",
      "id",
      "parent_id",
      "parts",
      "role",
      "status",
    ]);
  });

  it("types ConversationRow and MessageRow as the composed tables' rows", () => {
    expectTypeOf<ConversationRow>().toEqualTypeOf<typeof conversation.$inferSelect>();
    expectTypeOf<MessageRow>().toEqualTypeOf<typeof message.$inferSelect>();
  });
});
