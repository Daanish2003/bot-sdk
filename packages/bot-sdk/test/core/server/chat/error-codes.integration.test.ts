import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createChatHandler } from "../../../../plugins/assistant/server/over";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { resolveRateLimits } from "../../../../core/server/rate-limits";
import type { ChatCommand } from "../../../../plugins/assistant/shared/chat/command";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text } from "../../../support/fake-adapter";
import { sendAs } from "../../../support/sdk";
import { insertUser } from "../../../support/users";

const anthropicModel = "anthropic:claude-sonnet-5-5";

/** A signed-in user with Anthropic credentials, an empty titled Conversation and a scripted adapter. */
async function setup({
  byok,
  rateLimits,
}: { byok?: boolean; rateLimits?: ReturnType<typeof resolveRateLimits> } = {}) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds: [round(text("Hello"))] });
  const deps: TestDeps = createTestSdk({
    adapterFor: () => fake.adapter,
    ...(byok === undefined ? {} : { byok }),
    ...(rateLimits ? { rateLimits } : {}),
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  const conv = await insertConversation(user, {
    model: anthropicModel,
    title: "Test Conversation",
  });
  const send = (fields: Partial<ChatCommand> & Record<string, unknown> = {}, as = user) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Hi",
            attachmentIds: [],
            model: anthropicModel,
            webSearch: false,
            ...fields,
          },
        }),
      }),
      as,
      deps,
    );
  return { user, deps, conv, send };
}

/**
 * Every refusal the chat route answers with a JSON body is a dictionary code and its params, never
 * a sentence (spec #256). The HTTP status is the refusal's; the body is `{ code, params }`.
 */
describe("the chat route's refusals carry a code and params", () => {
  it("answers a request without a command with error.invalidCommand", async () => {
    const { user, deps } = await setup();

    const response = await sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      }),
      user,
      deps,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "error.invalidCommand", params: {} });
  });

  it("answers an unknown Conversation with error.conversationNotFound", async () => {
    const { send } = await setup();

    const response = await send({ conversationId: randomUUID() });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "error.conversationNotFound", params: {} });
  });

  it("answers a Model the user can't use with error.modelNotAvailable and the Model's id", async () => {
    const { send } = await setup();

    const response = await send({ model: "nope:model" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "error.modelNotAvailable",
      params: { model: "nope:model" },
    });
  });

  it("answers a Model with no usable credentials with error.pickAnotherModel when keys are off", async () => {
    const { send } = await setup({ byok: false });

    const response = await send();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "error.pickAnotherModel", params: {} });
  });

  it("answers a regenerate that adds attachments with error.regenerateAttachments", async () => {
    const { send } = await setup();

    const response = await send({ text: undefined, attachmentIds: [randomUUID()] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "error.regenerateAttachments", params: {} });
  });

  it("answers a parent outside the Conversation with error.parentNotFound", async () => {
    const { send } = await setup();

    const response = await send({ parentId: randomUUID() });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "error.parentNotFound", params: {} });
  });

  it("answers a regenerate of a reply with error.regenerateNeedsMessage", async () => {
    const { conv, send } = await setup();
    const reply = await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "Hello!",
      active: true,
    });

    const response = await send({ text: undefined, parentId: reply.id });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "error.regenerateNeedsMessage", params: {} });
  });

  it("answers an attachment the user doesn't own with error.attachmentNotFound", async () => {
    const { send } = await setup();

    const response = await send({ attachmentIds: [randomUUID()] });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "error.attachmentNotFound", params: {} });
  });

  it("answers a second Run while one streams with error.replyStreaming", async () => {
    const { conv, send } = await setup();
    await insertMessage({
      conversationId: conv.id,
      role: "assistant",
      text: "",
      active: true,
      status: "streaming",
    });

    const response = await send();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "error.replyStreaming", params: {} });
  });

  it("answers a Run over the start limit with error.tooManyMessages and Retry-After", async () => {
    const { send } = await setup({
      rateLimits: resolveRateLimits({ runStart: { limit: 1, windowSeconds: 60 } }),
    });
    await (await send()).text();

    const response = await send();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect(await response.json()).toEqual({ code: "error.tooManyMessages", params: {} });
  });

  it("answers a Run during shutdown with error.shuttingDown", async () => {
    const { deps, send } = await setup();
    deps.lifecycle.stopping = true;

    const response = await send();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "error.shuttingDown", params: {} });
  });

  it("answers a signed-out Run with error.unauthorized", async () => {
    const { deps } = await setup();
    const handler = createChatHandler(deps, { basePath: "/api/chat", getUser: () => null });

    const response = await handler(
      new Request("http://localhost/api/chat/run", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "error.unauthorized", params: {} });
  });

  it("answers a join with a bad Run id, or an unknown one, with a code", async () => {
    const { user, deps } = await setup();

    const bad = await sendAs(
      new Request("http://localhost/api/chat/run?runId=nope", { method: "GET" }),
      user,
      deps,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: "error.invalidRunId", params: {} });

    const unknown = await sendAs(
      new Request(`http://localhost/api/chat/run?runId=${randomUUID()}`, { method: "GET" }),
      user,
      deps,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ code: "error.runNotFound", params: {} });
  });
});
