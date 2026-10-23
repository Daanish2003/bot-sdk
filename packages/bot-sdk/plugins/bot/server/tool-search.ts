import { type AnyServerTool, convertSchemaToJsonSchema, toolDefinition } from "@tanstack/ai";
import { z } from "zod";

/*
 * Names-first tools (slide 24): the Model is sent a fixed `tools` list, and sees every other
 * tool's name and one line in its first message. It loads a deferred tool's definition with
 * `describe_tool` and calls it with `run_tool`, so the list, and the cache behind it, never change.
 */

export const describeToolName = "describe_tool";
export const runToolName = "run_tool";

/** The tools every call sends. Everything else the Bot has is deferred, plugin and connector tools included. */
const directToolNames: ReadonlySet<string> = new Set([
  "send_to_user",
  "web_search",
  "search_memory",
  "shell",
  "read",
  "write",
  "edit",
  "list",
  "start_helper",
  describeToolName,
  runToolName,
]);

/** Whether `tool` is sent on every call, rather than loaded on demand. */
export const isDirectTool = (tool: { name: string }) => directToolNames.has(tool.name);

/** What a name that is no tool of the Bot's is answered. */
export const unknownToolError = (name: string) =>
  `No tool named ${name}. The tools are listed in your first message.`;

type Issue = { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] };

/**
 * `tool` with its arguments checked against its schema as the code has it now, which may differ
 * from the definition the Prompt start sent (a deploy changed it). A mismatch is an error that
 * names the arguments at fault and gives the current schema, so the Bot calls it again the new way.
 */
export function checkedTool(tool: AnyServerTool): AnyServerTool {
  const schema = tool.inputSchema;
  if (!schema || !tool.execute || !("~standard" in schema)) return tool;
  const { execute } = tool;
  return {
    ...tool,
    // The engine's own check says too little; this one runs in `execute`.
    inputSchema: z.looseObject({}),
    execute: async (args, context) => {
      const checked = await schema["~standard"].validate(args);
      if (!checked.issues) return execute(checked.value, context);
      const problems = checked.issues.map((issue: Issue) => {
        const path = (issue.path ?? []).map((key) =>
          String(typeof key === "object" ? key.key : key),
        );
        return path.length > 0 ? `${path.join(".")}: ${issue.message}` : issue.message;
      });
      return {
        error:
          `Invalid arguments for ${tool.name} (${problems.join("; ")}). Call ${tool.name} again ` +
          `with arguments that match its current definition: ` +
          JSON.stringify(convertSchemaToJsonSchema(schema)),
      };
    },
  };
}

const describeToolDefinition = toolDefinition({
  name: describeToolName,
  description:
    "Load the description and arguments of a tool listed in your first message, before you call it " +
    `with ${runToolName}. Tools listed as deferred can only be called that way.`,
  inputSchema: z.object({
    name: z.string().meta({ description: "The tool's name, as listed in your first message." }),
  }),
});

const runToolDefinition = toolDefinition({
  name: runToolName,
  description:
    "Call a tool listed in your first message by its name, with arguments that match the " +
    `definition ${describeToolName} gave you. It does what calling the tool directly does.`,
  inputSchema: z.object({
    name: z.string().meta({ description: "The tool's name, as listed in your first message." }),
    args: z.looseObject({}).meta({ description: "The tool's arguments." }),
  }),
});

/**
 * `describe_tool` and `run_tool` over `tools`, the code's tools as they are now. They read the
 * live definitions, so a tool a deploy added or changed since the Prompt start works at once.
 * A call runs the tool's own `execute`, so its Approval, rules and recording are the tool's.
 * A name that is none of `tools` is answered by `missing` when it gives an error (a Connector tool
 * whose Connection listed nothing this Turn), else as unknown.
 */
export function toolSearchTools(
  tools: AnyServerTool[],
  missing: (name: string) => string | undefined = () => undefined,
): AnyServerTool[] {
  const notFound = (name: string) => ({ error: missing(name) ?? unknownToolError(name) });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const checked = new Map(tools.map((tool) => [tool.name, checkedTool(tool)]));
  const describeTool = describeToolDefinition.server(({ name }) => {
    const tool = byName.get(name);
    if (!tool) return notFound(name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ? convertSchemaToJsonSchema(tool.inputSchema) : {},
    };
  });
  const runTool = runToolDefinition.server(async ({ name, args }, context) => {
    const tool = checked.get(name);
    if (!tool?.execute) return notFound(name);
    return tool.execute(args, context);
  });
  return [describeTool, runTool];
}
