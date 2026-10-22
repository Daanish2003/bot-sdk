import type { ToolExecutionContext } from "@tanstack/ai";

import type { createPartsBuilder } from "../../shared/chat/parts";
import { fetchUrlToolName } from "../../shared/chat/fetch-url";
import { generateImageToolName } from "../../shared/chat/generated-image";
import { searchPastChatsToolName } from "../../shared/chat/past-chats";
import { webSearchToolName } from "../../shared/chat/web-search";
import type { StoredPart, ToolError } from "../../shared/message-parts";
import type { QuotaCheck } from "../../../models/server/meter";

/** Tool calls one reply may make across the tools that count against its budget (spec #91). */
export const maxToolCallsPerReply = 10;

export const toolCallLimitError = "tool call limit reached";

/** Where a tool comes from: built in, the Host's own (`createBotSdk({ tools })`) or an MCP server's. */
type ToolSource = Extract<StoredPart, { type: "tool_call" }>["source"];

/**
 * The built-in tools whose calls don't count against the reply's budget: `web_search` and
 * `fetch_url` have their own caps, and `search_past_chats` is free.
 */
const unbudgeted: ReadonlySet<string> = new Set([
  webSearchToolName,
  fetchUrlToolName,
  searchPastChatsToolName,
]);

/**
 * Whether a call takes from the reply's budget. This is the one rule: a Run takes from the budget
 * by it (`trackedTool`), and a resumed Run rebuilds the budget by it (`spentCalls`), so both agree
 * (ADR 0008). Every call of a Host or MCP tool counts, and so does every call of a built-in tool
 * not in `unbudgeted`, whatever its outcome, except a call its tool's own cap refused (an image
 * past the Run's 4): that cap is asked before the budget, so the call takes nothing.
 */
const countsAgainstBudget = (call: { name: string; source: ToolSource; capped: boolean }) =>
  !call.capped && (call.source !== "builtin" || !unbudgeted.has(call.name));

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

/** The call a stored part is, or `undefined` for a part that isn't a call. */
function callOf(part: StoredPart) {
  const builtin = (name: string) => ({ name, source: "builtin" as const, capped: false });
  switch (part.type) {
    case "tool_call":
      return { name: part.name, source: part.source, capped: false };
    case "web_search":
      return builtin(webSearchToolName);
    case "past_chats_search":
      return builtin(searchPastChatsToolName);
    case "generated_image":
      // A call the budget refused is `limit_reached` too. Leaving it out changes nothing: the
      // budget refuses only once it is spent.
      return { ...builtin(generateImageToolName), capped: part.errorReason === "limit_reached" };
    default:
      return undefined;
  }
}

/**
 * Calls a reply has already made that count against its budget: every call that ran, ended or was
 * cut off, of a tool that counts. A call waiting for Approval, or denied, never ran. An Artifact's
 * `artifact` part is not counted again: its call is.
 */
export function spentCalls(parts: StoredPart[]): number {
  return parts.filter((part) => {
    const call = callOf(part);
    return (
      call !== undefined &&
      countsAgainstBudget(call) &&
      "state" in part &&
      (part.state === "done" || part.state === "error" || part.state === "cancelled")
    );
  }).length;
}

/** What one Run's tools write to: the reply's parts, its change flag and its call budget. */
export type RunToolState = {
  parts: ReturnType<typeof createPartsBuilder>;
  onChange: () => void;
  budget: ToolBudget;
};

/** How a tool records its call in the reply's parts, for what the tracked call decides. */
export type CallPart<Input, Output, Started> = {
  /** Starts the call's part. What it answers is the body's `started`. */
  start: (toolCallId: string, input: Input) => Started;
  /**
   * Ends the part as refused, past the tool's own cap (`cap`), past the reply's budget (`limit`)
   * or by the Quota, and answers the result.
   */
  refused: (toolCallId: string, why: "cap" | "limit" | "quota") => Output;
  /** Ends the part as failed by what the body threw, and answers the result. */
  failed: (toolCallId: string, caught: unknown) => Output;
};

/** One call, as the body of a tracked tool gets it. */
export type TrackedCall<Started> = {
  toolCallId: string;
  /** The Run's signal: it aborts when the Run ends (Stop, the run cap, a deploy). */
  signal: AbortSignal | undefined;
  started: Started;
  context: ToolExecutionContext | undefined;
};

/**
 * A tool's `execute`, tracked for one Run: each call is keyed by the id TanStack AI gives it, its
 * part is started and `onChange` called, and then, in order, it asks `capReached` whether the
 * tool's own cap refuses it, takes a call from the reply's budget (when the tool counts against
 * it), asks `meter` whether the Quota lets it run, and runs `body`, which ends the part. Nothing
 * before `meter` is awaited, so parallel calls can't pass a cap together. A refusal ends the part
 * through `part.refused` and runs nothing. Whatever `body` throws becomes the call's failure
 * (`part.failed`), so the reply continues, except a call cut off by the Run ending (its signal
 * aborts): that one stays running, and the Run closes it as cancelled. `onChange` is called again
 * once the call has ended.
 */
export function trackedTool<Input, Output, Started = void>(
  toolName: string,
  { onChange, budget }: Pick<RunToolState, "onChange" | "budget">,
  {
    part,
    source = "builtin",
    capReached,
    meter,
  }: {
    part: CallPart<Input, Output, Started>;
    /** A Host or MCP tool's source; unset, the tool is built in. */
    source?: ToolSource;
    /** Whether the tool's own cap for the Run is reached: a call it refuses takes nothing. */
    capReached?: () => boolean;
    /** Checks the Quota before the call runs (ADR 0007). */
    meter?: { mayRun(): Promise<QuotaCheck> };
  },
  body: (input: Input, call: TrackedCall<Started>) => Promise<Output>,
): (input: Input, context?: ToolExecutionContext) => Promise<Output> {
  const counted = countsAgainstBudget({ name: toolName, source, capped: false });
  return async (input, context) => {
    // TanStack AI passes the call's id to every server tool; the stored part is keyed by it.
    const toolCallId = context?.toolCallId;
    if (!toolCallId) throw new Error(`${toolName} was called without a tool call id`);
    const started = part.start(toolCallId, input);
    onChange();
    try {
      if (capReached?.()) return part.refused(toolCallId, "cap");
      if (counted && !budget.take()) return part.refused(toolCallId, "limit");
      if (meter && !(await meter.mayRun()).ok) return part.refused(toolCallId, "quota");
      const signal = context?.abortSignal;
      return await body(input, { toolCallId, signal, started, context });
    } catch (caught) {
      if (context?.abortSignal?.aborted) throw caught;
      return part.failed(toolCallId, caught);
    } finally {
      onChange();
    }
  };
}

/** Ends a running `tool_call` part with `result` (and the error the reader sees), and answers it. */
export function endToolCall<Result>(
  parts: RunToolState["parts"],
  toolCallId: string,
  state: "done" | "error",
  result: Result,
  error?: ToolError,
): Result {
  parts.finishToolCall(toolCallId, { state, result, ...(error && { error }) });
  return result;
}

/** What the Model and the reader get for a `tool_call` past the reply's budget. */
export const limitReached = (parts: RunToolState["parts"], toolCallId: string) =>
  endToolCall(
    parts,
    toolCallId,
    "error",
    { error: toolCallLimitError },
    { code: "chat.toolError.limit" },
  );
