import type { z } from "zod";

const withoutFences = (reply: string) => reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

/**
 * `text` up to the end of the object or array it starts with, so what follows it is dropped.
 * Text with no such end stays whole, for `JSON.parse` to read or reject.
 */
function firstJsonValue(text: string): string {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if ((char === "}" || char === "]") && --depth <= 0) return text.slice(0, index + 1);
  }
  return text;
}

/**
 * Parses a Model reply as JSON and validates it with Zod, after stripping code fences. Text after
 * the JSON is ignored; text before it throws.
 */
export function parseReply<T extends z.ZodType>(schema: T, reply: string): z.infer<T> {
  return schema.parse(JSON.parse(firstJsonValue(withoutFences(reply))));
}

/**
 * `parseReply` for a reply that must be nothing but JSON: text after it throws too. For a reply
 * that decides whether something may run, where that text could take the JSON back.
 */
export function parseWholeReply<T extends z.ZodType>(schema: T, reply: string): z.infer<T> {
  return schema.parse(JSON.parse(withoutFences(reply)));
}
