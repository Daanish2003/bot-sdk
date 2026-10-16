import type { AnyServerTool } from "@tanstack/ai";

import { endToolCall, limitReached, type RunToolState, trackedTool } from "./tracked-tool";

/**
 * The Host's own tools (`createBotSdk({ tools })`), written with TanStack AI's
 * `toolDefinition(...).server(fn)`. `fn` gets the user's and the Conversation's ids as the
 * context: `.server<HostToolContext>(...)`, then `context.context.userId`.
 */
export type HostToolContext = { userId: string; conversationId: string };

/** A Host tool, as `createBotSdk({ tools })` takes it. */
export type HostServerTool = AnyServerTool;

/**
 * The tools with Approval lifted for the names a Conversation allows (its `allowedTools`, #159).
 * Any other tool comes back as it was, so its Approval still applies. The names are the ones the
 * Model sees: a Host tool's name, an MCP tool's `<serverKey>_<tool>`.
 */
export function allowTools<T extends AnyServerTool>(tools: T[], allowedTools: string[]): T[] {
  if (allowedTools.length === 0) return tools;
  return tools.map((tool) =>
    allowedTools.includes(tool.name) ? { ...tool, needsApproval: false } : tool,
  );
}

/**
 * Tools of one source (`host` or `mcp`) for one reply, each call tracked (`trackedTool`) as a
 * `tool_call` part under that source. A tool that throws fails only its own call: the error becomes
 * its result and the reply continues. Past the reply's budget, a call gets `toolCallLimitError` and
 * runs nothing.
 */
export function trackTools(
  tools: AnyServerTool[],
  { source, ...run }: RunToolState & { source: "host" | "mcp" },
): AnyServerTool[] {
  const { parts } = run;
  return tools.map((tool) => ({
    ...tool,
    execute: trackedTool(
      tool.name,
      run,
      {
        source,
        part: {
          start: (toolCallId, args: unknown) =>
            parts.startToolCall({ toolCallId, name: tool.name, source, args }),
          refused: (toolCallId) => limitReached(parts, toolCallId),
          failed: (toolCallId, caught) => {
            const message = caught instanceof Error ? caught.message : String(caught);
            // The Model reads the Host's message as it is; the reader gets the code and the message.
            return endToolCall(
              parts,
              toolCallId,
              "error",
              { error: message },
              { code: "chat.toolError.failed", params: { message } },
            );
          },
        },
      },
      async (args, { toolCallId, context }): Promise<unknown> =>
        endToolCall(parts, toolCallId, "done", await tool.execute?.(args, context)),
    ),
  }));
}
