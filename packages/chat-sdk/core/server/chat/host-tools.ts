import type { AnyServerTool, ToolExecutionContext } from "@tanstack/ai";

import { fetchUrlToolName } from "../../shared/chat/fetch-url";
import type { createPartsBuilder } from "../../shared/chat/parts";
import type { StoredPart } from "../../shared/message-parts";

/**
 * The Host's own tools (`createChat({ tools })`), written with TanStack AI's
 * `toolDefinition(...).server(fn)`. `fn` gets the user's and the Conversation's ids as the
 * context: `.server<HostToolContext>(...)`, then `context.context.userId`.
 */
export type HostToolContext = { userId: string; conversationId: string };

/** A Host tool, as `createChat({ tools })` takes it. */
export type HostServerTool = AnyServerTool;

/** Tool calls one reply may make across the Host's tools and the MCP tools (spec #91). */
export const maxToolCallsPerReply = 10;

export const toolCallLimitError = "tool call limit reached";

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
 * The calls a reply has left. One budget is shared by every tool of the reply, across its Runs
 * (ADR 0008), so a resumed Run starts with the calls its earlier Runs made.
 */
export type ToolBudget = { take: () => boolean };

export function createToolBudget(used: number): ToolBudget {
  let calls = used;
  return {
    take() {
      if (calls >= maxToolCallsPerReply) return false;
      calls++;
      return true;
    },
  };
}

/**
 * Calls a reply has already made that took from its budget, so a resumed Run starts where the
 * Run before it stopped: every call that ran, ended or was cut off, of a Host or MCP tool,
 * `create_artifact`, `update_artifact`, `generate_image` (its part is `generated_image`, spec #278)
 * or `search_knowledge` (its part is `knowledge_search`, spec #357). An Artifact's `artifact` part
 * is not counted again: its call is. `fetch_url` and `web_search` have their own caps and take
 * nothing, and neither does an image the Run's own cap refused (`limit_reached`), which is refused
 * before the budget is asked. A call the budget itself refused is counted, which changes nothing:
 * the budget refuses only once it is spent.
 */
export function spentCalls(parts: StoredPart[]): number {
  const ended = (state: string) => state === "done" || state === "error" || state === "cancelled";
  return parts.filter((part) => {
    if (part.type === "tool_call") {
      return ended(part.state) && !(part.source === "builtin" && part.name === fetchUrlToolName);
    }
    if (part.type === "generated_image") {
      return ended(part.state) && part.errorReason !== "limit_reached";
    }
    return part.type === "knowledge_search" && ended(part.state);
  }).length;
}

/**
 * Tools of one source (`host` or `mcp`) for one reply. Each call is recorded in the reply's `parts`
 * under that source, and calls `onChange` when it changes. A tool that throws fails only its own
 * call: the error becomes its result and the reply continues. Past the reply's budget, a call gets
 * `toolCallLimitError` and runs nothing. A call cut off by the run ending (its signal aborts) stays
 * running, and the run closes it as cancelled.
 */
export function trackTools(
  tools: AnyServerTool[],
  {
    source,
    parts,
    onChange,
    budget,
  }: {
    source: "host" | "mcp";
    parts: ReturnType<typeof createPartsBuilder>;
    onChange: () => void;
    budget: ToolBudget;
  },
): AnyServerTool[] {
  return tools.map((tool) => {
    const run = tool.execute;
    return {
      ...tool,
      execute: async (args: unknown, context?: ToolExecutionContext<HostToolContext>) => {
        // TanStack AI passes the call's id to every server tool; the stored part is keyed by it.
        const toolCallId = context?.toolCallId;
        if (!toolCallId) throw new Error(`${tool.name} was called without a tool call id`);
        parts.startToolCall({ toolCallId, name: tool.name, source, args });
        onChange();
        try {
          if (!budget.take()) {
            const error = { error: toolCallLimitError };
            parts.finishToolCall(toolCallId, {
              state: "error",
              result: error,
              error: { code: "chat.toolError.limit" },
            });
            return error;
          }
          const result = await run?.(args, context);
          parts.finishToolCall(toolCallId, { state: "done", result });
          return result;
        } catch (caught) {
          if (context?.abortSignal?.aborted) throw caught;
          const message = caught instanceof Error ? caught.message : String(caught);
          // The Model reads the Host's message as it is; the reader gets the code and the message.
          parts.finishToolCall(toolCallId, {
            state: "error",
            result: { error: message },
            error: { code: "chat.toolError.failed", params: { message } },
          });
          return { error: message };
        } finally {
          onChange();
        }
      },
    };
  });
}
