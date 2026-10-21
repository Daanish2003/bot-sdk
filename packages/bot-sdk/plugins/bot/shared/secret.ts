import { z } from "zod";

/** An environment-variable-style name: what a `shell` call lists and a Secret card asks for. */
export const secretNameSchema = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]*$/,
    "name must be an environment-variable name: capital letters, digits and underscores, like GITHUB_TOKEN",
  )
  .max(100, "name must be at most 100 characters");

/**
 * A Message's request for a Secret (spec #691): the name it asks for and why the Bot needs it. The
 * stored part is `{ type: "secret", name, why }`; the value never appears in it.
 */
export const secretRequestSchema = z.object({
  type: z.literal("secret"),
  name: secretNameSchema,
  why: z.string(),
});

export type SecretRequest = z.infer<typeof secretRequestSchema>;

/** A saved Secret as the client sees it: its name and when it was saved, never its value. */
export type BotSecret = { name: string; createdAt: Date };
