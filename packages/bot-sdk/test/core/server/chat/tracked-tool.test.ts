import { describe, expect, it, vi } from "vitest";

import {
  createToolBudget,
  endToolCall,
  limitReached,
  maxToolCallsPerReply,
  spentCalls,
  toolCallLimitError,
  trackedTool,
} from "../../../../core/server/chat/tracked-tool";
import { createPartsBuilder } from "../../../../core/shared/chat/parts";
import type { StoredPart } from "../../../../core/shared/message-parts";

type Body = (input: { n: number }, signal: AbortSignal | undefined) => Promise<unknown>;

/**
 * A tool tracked as a `tool_call` part. `body` is what it runs; unset, it answers `{ ok: n }`.
 * Answers the tool's `execute`, the reply's parts, the `onChange` spy and the spy on `body`.
 */
function trackedWith({
  name = "server_time",
  source,
  used = 0,
  capReached,
  meter,
  body = async ({ n }) => ({ ok: n }),
}: {
  name?: string;
  source?: "host" | "mcp";
  used?: number;
  capReached?: () => boolean;
  meter?: { mayRun: () => Promise<{ ok: true } | { ok: false; resetsAt: Date }> };
  body?: Body;
} = {}) {
  const parts = createPartsBuilder();
  const onChange = vi.fn();
  const run = vi.fn(body);
  const refused = vi.fn((toolCallId: string, why: "cap" | "limit" | "quota") =>
    why === "limit"
      ? limitReached(parts, toolCallId)
      : endToolCall(parts, toolCallId, "error", { error: why }),
  );
  const execute = trackedTool(
    name,
    { onChange, budget: createToolBudget(used) },
    {
      ...(source && { source }),
      ...(capReached && { capReached }),
      ...(meter && { meter }),
      part: {
        start: (toolCallId, input: { n: number }) =>
          parts.startToolCall({ toolCallId, name, source: source ?? "builtin", args: input }),
        refused,
        failed: (toolCallId, caught) =>
          endToolCall(parts, toolCallId, "error", { error: (caught as Error).message }),
      },
    },
    async (input, { toolCallId, signal }) =>
      endToolCall(parts, toolCallId, "done", await run(input, signal)),
  );
  const call = (n: number, context: object = { toolCallId: `call-${n}` }) =>
    execute({ n }, context as never);
  return { call, parts: () => parts.parts().parts, onChange, run, refused };
}

const refusing = {
  mayRun: async () => ({ ok: false as const, resetsAt: new Date("2026-01-02T00:00:00Z") }),
};

describe("trackedTool", () => {
  it("throws for a call without a tool call id, and starts no part", async () => {
    const { call, parts, run } = trackedWith();

    await expect(call(1, {})).rejects.toThrow("server_time was called without a tool call id");
    expect(parts()).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("starts the call's part and calls onChange before the body runs, and again once it ends", async () => {
    let finish!: (value: unknown) => void;
    const { call, parts, onChange } = trackedWith({
      body: () => new Promise((resolve) => (finish = resolve)),
    });

    const pending = call(1);
    await vi.waitFor(() => expect(finish).toBeDefined());

    expect(parts()).toEqual([
      expect.objectContaining({ type: "tool_call", toolCallId: "call-1", state: "running" }),
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);

    finish({ now: "noon" });
    await expect(pending).resolves.toEqual({ now: "noon" });
    expect(parts()).toEqual([
      expect.objectContaining({ toolCallId: "call-1", state: "done", result: { now: "noon" } }),
    ]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("refuses a call once the reply's budget is spent, and runs nothing", async () => {
    const { call, parts, run } = trackedWith({ used: maxToolCallsPerReply - 1 });

    await expect(call(1)).resolves.toEqual({ ok: 1 });
    await expect(call(2)).resolves.toEqual({ error: toolCallLimitError });

    expect(run).toHaveBeenCalledTimes(1);
    expect(parts()[1]).toMatchObject({
      toolCallId: "call-2",
      state: "error",
      error: { code: "chat.toolError.limit" },
    });
  });

  it("runs an uncounted built-in tool on a spent budget, but not a Host tool of that name", async () => {
    const builtin = trackedWith({ name: "fetch_url", used: maxToolCallsPerReply });
    const host = trackedWith({ name: "fetch_url", source: "host", used: maxToolCallsPerReply });

    await expect(builtin.call(1)).resolves.toEqual({ ok: 1 });
    await expect(host.call(1)).resolves.toEqual({ error: toolCallLimitError });
  });

  it("refuses a call past the tool's own cap without taking from the budget", async () => {
    let capped = true;
    const { call, run, refused } = trackedWith({
      used: maxToolCallsPerReply - 1,
      capReached: () => capped,
    });

    await expect(call(1)).resolves.toEqual({ error: "cap" });
    capped = false;
    // The cap's refusal took nothing: the budget's last call is still there.
    await expect(call(2)).resolves.toEqual({ ok: 2 });

    expect(refused).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a call the Quota refuses, and runs nothing", async () => {
    const { call, parts, run, refused } = trackedWith({ meter: refusing });

    await expect(call(1)).resolves.toEqual({ error: "quota" });

    expect(refused).toHaveBeenCalledWith("call-1", "quota");
    expect(run).not.toHaveBeenCalled();
    expect(parts()).toEqual([expect.objectContaining({ state: "error" })]);
  });

  it("rethrows what a call cut off by the Run ending throws, leaving its part running", async () => {
    const controller = new AbortController();
    const { call, parts, onChange } = trackedWith({
      body: async () => {
        controller.abort();
        throw new Error("The reply was stopped");
      },
    });

    await expect(call(1, { toolCallId: "call-1", abortSignal: controller.signal })).rejects.toThrow(
      "The reply was stopped",
    );

    expect(parts()).toEqual([expect.objectContaining({ state: "running" })]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ends a call whose body throws as its failure, and the reply goes on", async () => {
    const { call, parts } = trackedWith({
      body: async () => {
        throw new Error("The clock is broken");
      },
    });

    await expect(call(1)).resolves.toEqual({ error: "The clock is broken" });

    expect(parts()).toEqual([
      expect.objectContaining({ state: "error", result: { error: "The clock is broken" } }),
    ]);
  });
});

describe("spentCalls", () => {
  const toolCall = (name: string, source: "builtin" | "host", state = "done") =>
    ({ type: "tool_call", toolCallId: name, name, source, args: {}, state }) as StoredPart;
  const image = (errorReason?: string) =>
    ({
      type: "generated_image",
      toolCallId: "image",
      prompt: "a bicycle",
      aspectRatio: "square",
      state: errorReason ? "error" : "done",
      ...(errorReason && { errorReason }),
    }) as StoredPart;

  it("counts the calls that ran by the rule a Run takes from the budget by", () => {
    expect(
      spentCalls([
        toolCall("server_time", "host"),
        toolCall("fetch_url", "host"),
        toolCall("create_artifact", "builtin"),
        image(),
        image("quota_exceeded"),
      ]),
    ).toBe(5);
  });

  it("leaves out uncounted built-in tools, calls that didn't run, and images the Run's cap refused", () => {
    expect(
      spentCalls([
        toolCall("fetch_url", "builtin"),
        toolCall("send_mail", "host", "awaiting_approval"),
        image("limit_reached"),
        { type: "web_search", toolCallId: "search", query: "news", state: "done" } as StoredPart,
      ]),
    ).toBe(0);
  });
});
