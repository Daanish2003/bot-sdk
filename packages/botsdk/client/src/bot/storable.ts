import type { z } from "zod";

/** `schema`, refusing a text that can't be stored: Postgres takes no NUL in text or jsonb. */
export const storable = <Schema extends z.ZodString>(schema: Schema) =>
  schema.refine((text) => !text.includes("\u0000"), "NUL characters are not allowed");
