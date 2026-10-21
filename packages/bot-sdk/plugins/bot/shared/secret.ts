import { z } from "zod";

/**
 * Names that change how every command runs (the shell, the dynamic loader, a language runtime, git),
 * so a Secret can't take one: a Bot that could ask for `LD_PRELOAD` could hijack the next command.
 */
const reservedNames = new Set([
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "PATH",
  "HOME",
  "SHELL",
  "NODE_OPTIONS",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PERL5OPT",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
]);
const reservedPrefixes = ["LD_", "DYLD_", "BASH_FUNC_"];

/** Whether Secret `name` is one a Secret can't take. */
export const isReservedSecretName = (name: string): boolean =>
  reservedNames.has(name) || reservedPrefixes.some((prefix) => name.startsWith(prefix));

/** What a refused reserved name says. */
export const reservedSecretNameMessage = (name: string) =>
  `${name} is a reserved name: it changes how commands run, so it can't be a Secret`;

/** An environment-variable-style name: what a `shell` call lists and a Secret card asks for. */
export const secretNameSchema = z
  .string()
  .regex(
    /^[A-Z_][A-Z0-9_]*$/,
    "name must be an environment-variable name: capital letters, digits and underscores, like GITHUB_TOKEN",
  )
  .max(100, "name must be at most 100 characters")
  .refine((name) => !isReservedSecretName(name), {
    error: (issue) => reservedSecretNameMessage(String(issue.input)),
  });

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
