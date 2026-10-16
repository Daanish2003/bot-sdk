import { getTableConfig, index, text } from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import { chatSchema } from "../../../../core/server/db/chat-schema";
import {
  assertNoClashes,
  composeIndexes,
  type NamedPluginSchema,
} from "../../../../core/server/db/plugin-schema";
import {
  conversation,
  message,
  type ConversationRow,
  type MessageRow,
} from "../../../../core/server/db/schema";

const empty = { tables: {}, enums: {}, fields: {} };

describe("composing the chat schema", () => {
  it("throws, naming both plugins and the column, when two plugins add the same column", () => {
    const schemas: NamedPluginSchema[] = [
      {
        id: "alpha",
        schema: { ...empty, fields: { conversation: { columns: { mood: text() } } } },
      },
      { id: "beta", schema: { ...empty, fields: { conversation: { columns: { mood: text() } } } } },
    ];

    expect(() => assertNoClashes(schemas)).toThrow(/alpha.*beta.*conversation\.mood/);
  });

  it("throws when two plugins' columns share a Postgres name under different keys", () => {
    const schemas: NamedPluginSchema[] = [
      { id: "alpha", schema: { ...empty, fields: { message: { columns: { a: text("mood") } } } } },
      { id: "beta", schema: { ...empty, fields: { message: { columns: { b: text("mood") } } } } },
    ];

    expect(() => assertNoClashes(schemas)).toThrow(/alpha.*beta.*message\.mood/);
  });

  it("throws, naming both plugins and the index, when two plugins add the same index", () => {
    const schemas: NamedPluginSchema[] = ["alpha", "beta"].map((id) => ({
      id,
      schema: {
        ...empty,
        fields: {
          conversation: {
            columns: {},
            indexes: (t) => [index("conversation_mood_idx").on(t.id!)],
          },
        },
      },
    }));
    const table = chatSchema.table(
      "conversation",
      { id: text().primaryKey() },
      composeIndexes("conversation", schemas),
    );

    expect(() => getTableConfig(table)).toThrow(/alpha.*beta.*conversation_mood_idx/);
  });

  it("throws, naming both plugins and the table, when two plugins declare the same table", () => {
    const widget = () => chatSchema.table("widget", { id: text().primaryKey() });
    const schemas: NamedPluginSchema[] = [
      { id: "alpha", schema: { ...empty, tables: { widget: widget() } } },
      { id: "beta", schema: { ...empty, tables: { widget: widget() } } },
    ];

    expect(() => assertNoClashes(schemas)).toThrow(/alpha.*beta.*widget/);
  });

  it("throws, naming both plugins and the enum, when two plugins declare the same enum", () => {
    const schemas: NamedPluginSchema[] = ["alpha", "beta"].map((id) => ({
      id,
      schema: { ...empty, enums: { mood: chatSchema.enum("mood", ["up", "down"]) } },
    }));

    expect(() => assertNoClashes(schemas)).toThrow(/alpha.*beta.*mood/);
  });

  it("throws when a plugin declares a table named like a core table", () => {
    const schemas: NamedPluginSchema[] = [
      {
        id: "alpha",
        schema: { ...empty, tables: { mine: chatSchema.table("message", { id: text() }) } },
      },
    ];

    expect(() => assertNoClashes(schemas)).toThrow(/core.*alpha.*message/);
  });

  it("composes the core's and the assistant's columns and indexes into conversation and message", () => {
    const conversationConfig = getTableConfig(conversation);
    const messageConfig = getTableConfig(message);

    expect(conversationConfig.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["id", "user_id", "model", "project_id", "temporary"]),
    );
    expect(conversationConfig.indexes.map((i) => i.config.name)).toEqual(
      expect.arrayContaining([
        "conversation_title_trgm_idx",
        "conversation_unprojected_user_id_last_message_at_idx",
        "conversation_project_id_last_message_at_idx",
      ]),
    );
    expect(messageConfig.columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["parts", "search_text", "run_number", "hidden_reason"]),
    );
  });

  it("types ConversationRow and MessageRow as the composed tables' rows", () => {
    expectTypeOf<ConversationRow>().toEqualTypeOf<typeof conversation.$inferSelect>();
    expectTypeOf<MessageRow>().toEqualTypeOf<typeof message.$inferSelect>();
    expectTypeOf<ConversationRow["model"]>().toEqualTypeOf<string | null>();
    expectTypeOf<MessageRow["runNumber"]>().toEqualTypeOf<number>();
  });
});
