import { toolDefinition } from "@tanstack/ai";
import { and, eq, sql } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import { z } from "zod";

import { defineFeature, defineJob, type Database } from "../../core/server/index";

/*
 * A test-only feature written against the public `defineFeature` (spec #871): a Bot pins short
 * notes with a tool, sees them in its Prompt start, and each Turn's end records what it saw and
 * queues a digest job. Its one table lives only while a test file creates it (`createPinsTable`).
 */

/** The feature's only table: foreign keys into core tables would be allowed, columns on them not. */
export const pin = pgSchema("botsdk").table("test_pin", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  botId: text("bot_id").notNull(),
  /** `pin` for a pinned note, `turn_end` for an `afterTurn` record, `digest` for the job's. */
  kind: text("kind").notNull(),
  text: text("text").notNull(),
});

export async function createPinsTable(db: Database) {
  await db.execute(sql`create table if not exists botsdk.test_pin (
    id text primary key, user_id text not null, bot_id text not null, kind text not null,
    text text not null)`);
}

export async function dropPinsTable(db: Database) {
  await db.execute(sql`drop table if exists botsdk.test_pin`);
}

/** The job each Turn's end queues: it records a digest of the Bot's pins. */
export const pinsDigestJob = defineJob({
  name: "test-pins.digest",
  payload: z.object({ userId: z.string(), botId: z.string(), turnId: z.string() }),
  run: async ({ userId, botId, turnId }, { db }) => {
    const pins = await db
      .select({ text: pin.text })
      .from(pin)
      .where(and(eq(pin.botId, botId), eq(pin.kind, "pin")));
    await db.insert(pin).values({
      id: `digest-${turnId}`,
      userId,
      botId,
      kind: "digest",
      text: pins.map((row) => row.text).join(", "),
    });
  },
});

const pinsSection = (pins: string[]) => ["[Pinned notes]", ...pins].join("\n");
const added = "Pin added: ";
const removed = "Pin removed: ";

export function pins() {
  return defineFeature({
    id: "pins",
    needs: ["computer"],
    schema: { tables: { pin } },
    api: ({ db }) => ({
      list: async ({ userId }: { userId: string }) =>
        (
          await db
            .select({ text: pin.text })
            .from(pin)
            .where(and(eq(pin.userId, userId), eq(pin.kind, "pin")))
        ).map((row) => row.text),
    }),
    tools: (turn, { db }) => [
      toolDefinition({
        name: "pin_note",
        description: "Pins a short note.",
        inputSchema: z.object({ text: z.string() }),
      }).server(async ({ text: note }) => {
        await db.insert(pin).values({
          id: `pin-${note}`,
          userId: turn.userId,
          botId: turn.botId,
          kind: "pin",
          text: note,
        });
        return { pinned: true };
      }),
    ],
    prompt: async (turn, { db }) => {
      const rows = await db
        .select({ text: pin.text })
        .from(pin)
        .where(and(eq(pin.botId, turn.botId), eq(pin.kind, "pin")));
      const now = rows.map((row) => row.text).sort();
      // What the Bot has seen: the Prompt start's pins, then the pin notes it was told since.
      const seen = new Set((turn.built ?? "").split("\n").slice(1));
      for (const note of turn.told) {
        if (note.startsWith(added)) seen.add(note.slice(added.length));
        if (note.startsWith(removed)) seen.delete(note.slice(removed.length));
      }
      return {
        section: pinsSection(now),
        changeNotes: [
          ...now.filter((note) => !seen.has(note)).map((note) => `${added}${note}`),
          ...[...seen].filter((note) => !now.includes(note)).map((note) => `${removed}${note}`),
        ],
      };
    },
    afterTurn: async (tx, turn, { jobs }) => {
      // What the Turn's row says inside the end's transaction: only it has the ended status yet.
      const { rows } = await tx.execute<{ status: string }>(
        sql`select status from botsdk.bot_turn where id = ${turn.id}`,
      );
      await tx.insert(pin).values({
        id: `turn-end-${turn.id}`,
        userId: turn.userId,
        botId: turn.botId,
        kind: "turn_end",
        text: rows[0]?.status ?? "none",
      });
      await jobs.enqueueIn(tx, pinsDigestJob, {
        userId: turn.userId,
        botId: turn.botId,
        turnId: turn.id,
      });
    },
    jobs: [pinsDigestJob],
    userData: {
      delete: {
        before: async (tx, userId) => {
          await tx.delete(pin).where(eq(pin.userId, userId));
        },
      },
      export: async (tx, userId) => ({
        pins: (
          await tx
            .select({ kind: pin.kind, text: pin.text })
            .from(pin)
            .where(eq(pin.userId, userId))
            .orderBy(pin.id)
        ).map((row) => `${row.kind}: ${row.text}`),
      }),
    },
  });
}
