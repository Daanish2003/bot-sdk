import { pgSchema } from "drizzle-orm/pg-core";

/**
 * The Postgres schema of every SDK table and enum. It is fixed, not configurable, so a Host never
 * names it (ADR 0005, spec #70).
 */
export const chatSchema = pgSchema("chat");
