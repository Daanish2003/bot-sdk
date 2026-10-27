import type { z } from "zod";

/** Parses a Model reply as JSON and validates it with Zod, after stripping code fences. */
export function parseReply<T extends z.ZodType>(schema: T, reply: string): z.infer<T> {
  const json = reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return schema.parse(JSON.parse(json));
}
