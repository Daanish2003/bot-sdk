import { storedParts, type StoredPart } from "../../../../core/shared/message-parts";
import { message } from "../../../../core/server/db/schema/chat";
import { toolDefinition } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { HostToolContext } from "../../../../core/server/chat/host-tools";
import { stopRun } from "../../../../core/server/chat/run";
import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps } from "../../../../core/server/deps";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { sendAs } from "../../../support/sdk";
import { insertUser, type TestUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";

/** Resolves once the tool has been called; the test waits on it before it stops the reply. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

type Seen = { args: unknown; context: unknown; toolCallId?: string; signal?: AbortSignal };

/** A Host tool that records how it was called and answers with the time it was given. */
function serverTime(seen: Seen[]) {
  return toolDefinition({
    name: "server_time",
    description: "The current server time.",
    inputSchema: z.object({ zone: z.string().optional() }),
  }).server<HostToolContext>(async (args, ctx) => {
    seen.push({
      args,
      context: ctx?.context,
      toolCallId: ctx?.toolCallId,
      signal: ctx?.abortSignal,
    });
    return { now: "2026-10-10T12:00:00.000Z" };
  });
}

const timeCall = (id: string, args: unknown = { zone: "UTC" }) =>
  toolCall({ id, name: "server_time", input: args });

/** A signed-in user with Anthropic credentials, and a fake adapter playing `rounds`. */
async function setup({
  rounds,
  tools,
  deps: overrides = {},
}: {
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  tools: AppDeps["tools"];
  deps?: TestDepsOverrides;
}) {
  const user: TestUser = await insertUser();
  const fake = createFakeAdapter({ rounds });
  const deps = createTestDeps({
    adapterFor: () => fake.adapter,
    tools,
    ...overrides,
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  // Titled, so a complete run doesn't call the adapter again to title it (#26).
  const conv = await insertConversation(user, { title: "Host tools" });
  const send = (command: { text?: string; parentId?: string | null } = {}) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "What time is it?",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  return { user, deps, fake, conv, send };
}

async function repliesOf(deps: AppDeps, conversationId: string) {
  const rows = await deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
  return rows.filter((row) => row.role === "assistant");
}

const replyOf = async (deps: AppDeps, conversationId: string) =>
  (await repliesOf(deps, conversationId)).at(-1)!;

const hostCall = (fields: Partial<Extract<StoredPart, { type: "tool_call" }>>) =>
  ({
    type: "tool_call",
    toolCallId: "call-1",
    name: "server_time",
    source: "host",
    args: { zone: "UTC" },
    result: { now: "2026-10-10T12:00:00.000Z" },
    state: "done",
    ...fields,
  }) as StoredPart;

describe("a Host tool in a reply", () => {
  it("is called with the user's id, the Conversation's id, the call id and the Run's signal", async () => {
    const seen: Seen[] = [];
    const { conv, send } = await setup({
      rounds: [round(timeCall("call-1")), round(text("It is noon."))],
      tools: [serverTime(seen)],
    });

    await (await send()).text();

    const [call] = seen;
    expect(call?.args).toEqual({ zone: "UTC" });
    expect(call?.toolCallId).toBe("call-1");
    expect(call?.signal).toBeInstanceOf(AbortSignal);
    expect(call?.context).toEqual({ userId: expect.any(String), conversationId: conv.id });
  });

  it("stores the call as a host tool_call part between the text around it", async () => {
    const seen: Seen[] = [];
    const { deps, conv, send } = await setup({
      rounds: [round(text("Let me check. "), timeCall("call-1")), round(text("It is noon."))],
      tools: [serverTime(seen)],
    });

    await (await send()).text();

    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        { type: "text", text: "Let me check. " },
        hostCall({}),
        { type: "text", text: "It is noon." },
      ]),
    });
  });

  it("feeds the result back to the Model as the tool's answer", async () => {
    const seen: Seen[] = [];
    const { fake, send } = await setup({
      rounds: [round(timeCall("call-1")), round(text("It is noon."))],
      tools: [serverTime(seen)],
    });

    await (await send()).text();

    expect(fake.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ now: "2026-10-10T12:00:00.000Z" }),
    });
  });

  it("stores a tool that throws as an error part, and the reply still completes", async () => {
    const boom = toolDefinition({
      name: "server_time",
      description: "Breaks.",
      inputSchema: z.object({ zone: z.string().optional() }),
    }).server(async () => {
      throw new Error("clock is broken");
    });
    const { fake, deps, conv, send } = await setup({
      rounds: [round(timeCall("call-1")), round(text("I could not check."))],
      tools: [boom],
    });

    await (await send()).text();

    expect(fake.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ error: "clock is broken" }),
    });
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      error: null,
      parts: storedParts([
        hostCall({ state: "error", result: { error: "clock is broken" } }),
        { type: "text", text: "I could not check." },
      ]),
    });
  });

  it("caps Host tool calls at 10 per reply: the 11th runs nothing and gets an error", async () => {
    const seen: Seen[] = [];
    const calls = Array.from({ length: 11 }, (_, index) => timeCall(`call-${index + 1}`));
    const { fake, deps, conv, send } = await setup({
      rounds: [round(...calls), round(text("Done."))],
      tools: [serverTime(seen)],
    });

    await (await send()).text();

    expect(seen).toHaveLength(10);
    expect(fake.calls[1]!.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-11",
      content: JSON.stringify({ error: "tool call limit reached" }),
    });
    const reply = await replyOf(deps, conv.id);
    expect(reply.parts.parts.at(-2)).toEqual(
      hostCall({
        toolCallId: "call-11",
        state: "error",
        result: { error: "tool call limit reached" },
      }),
    );
  });

  it("cancels the call when the reply is stopped: fn's signal aborts and the part ends cancelled", async () => {
    const started = deferred();
    let aborted = false;
    const hanging = toolDefinition({
      name: "server_time",
      description: "Waits for the user.",
      inputSchema: z.object({ zone: z.string().optional() }),
    }).server<HostToolContext>(
      (_args, ctx) =>
        new Promise((_resolve, reject) => {
          started.resolve();
          ctx?.abortSignal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const { deps, conv, send } = await setup({
      rounds: [round(timeCall("call-1"))],
      tools: [hanging],
    });

    const response = send();
    await started.promise;
    const reply = await replyOf(deps, conv.id);
    await stopRun(deps, reply.id);
    await (await response).text();

    expect(aborted).toBe(true);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "stopped",
      parts: storedParts([
        {
          type: "tool_call",
          toolCallId: "call-1",
          name: "server_time",
          source: "host",
          args: { zone: "UTC" },
          state: "cancelled",
        },
      ]),
    });
  });

  it("replays a stored call and its result to the Model in a later turn", async () => {
    const seen: Seen[] = [];
    const { fake, deps, conv, send } = await setup({
      rounds: [round(timeCall("call-1")), round(text("It is noon.")), round(text("Still noon."))],
      tools: [serverTime(seen)],
    });
    await (await send()).text();
    const first = await replyOf(deps, conv.id);

    await (await send({ parentId: first.id, text: "And now?" })).text();

    const history = fake.calls[2]!.messages;
    expect(history).toContainEqual({
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "server_time", arguments: JSON.stringify({ zone: "UTC" }) },
        },
      ],
    });
    expect(history).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-1",
        content: JSON.stringify({ now: "2026-10-10T12:00:00.000Z" }),
      }),
    );
  });
});
