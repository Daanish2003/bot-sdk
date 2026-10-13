import { storedParts, type GeneratedImagePart } from "../../../../core/shared/message-parts";
import { generatedImage } from "../../../../core/server/db/schema/generated-image";
import { conversation, message } from "../../../../core/server/db/schema/chat";
import { userSettings } from "../../../../core/server/db/schema/settings";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps, HostProvider } from "../../../../core/server/deps";
import { fakeImageAdapter } from "../../../../core/server/chat/fake-image-adapter";
import { insertConversation } from "../../../support/conversations";
import { createTestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { insertUser } from "../../../support/users";
import { chatRpc, sendAs } from "../../../support/sdk";
import type { ChatCommand } from "../../../../core/shared/chat/command";
import { getTestDb } from "../../../support/test-database";

const anthropicModel = "anthropic:claude-sonnet-5-5";
const hostImageModel = "openai:gpt-image-1-mini";

const hostProviders: HostProvider[] = [
  {
    provider: "openai",
    credentials: { apiKey: "host-openai-key" },
    models: [],
    imageModels: [
      { modelId: "gpt-image-1-mini", size: "1024x1024", quality: "medium", pricePerImageUsd: 0.01 },
    ],
  },
];

const imageCall = (id: string, input: { prompt: string; aspectRatio?: string }) =>
  toolCall({ id, name: "generate_image", input });

const image = (fields: Partial<GeneratedImagePart> = {}): GeneratedImagePart => ({
  type: "generated_image",
  toolCallId: "call-1",
  prompt: "a red bicycle",
  aspectRatio: "square",
  state: "done",
  ...fields,
});

/** A signed-in user with Anthropic credentials, and a Host Image Model unless `hostImage: false`. */
async function setup({
  rounds,
  imageAdapter = fakeImageAdapter(),
  hostImage = true,
  deps: overrides = {},
}: {
  rounds: Parameters<typeof createFakeAdapter>[0]["rounds"];
  imageAdapter?: ReturnType<typeof fakeImageAdapter>;
  hostImage?: boolean;
  deps?: TestDepsOverrides;
}) {
  const user = await insertUser();
  const fake = createFakeAdapter({ rounds });
  const deps = createTestDeps({
    adapterFor: () => fake.adapter,
    imageAdapterFor: () => imageAdapter,
    hostProviders: hostImage ? hostProviders : [],
    defaultImageModel: hostImage ? hostImageModel : null,
    ...overrides,
  });
  await saveCredentials(deps, user.id, {
    service: "anthropic",
    fields: { apiKey: "sk-ant-test-key" },
    hint: "…-key",
    verified: true,
  });
  // Titled, so a complete run doesn't call the adapter again to title it (#26).
  const conv = await insertConversation(user, { title: "Images" });
  const send = (command: Partial<ChatCommand> = {}) =>
    sendAs(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
          forwardedProps: {
            conversationId: conv.id,
            parentId: null,
            text: "Draw me a red bicycle",
            attachmentIds: [],
            model: anthropicModel,
            ...command,
          },
        }),
      }),
      user,
      deps,
    );
  return { user, deps, fake, conv, send };
}

/** The Conversation's Messages, oldest first. */
async function messagesOf(deps: AppDeps, conversationId: string) {
  return deps.db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.createdAt));
}

async function replyOf(deps: AppDeps, conversationId: string) {
  const rows = await messagesOf(deps, conversationId);
  return rows.findLast((row) => row.role === "assistant")!;
}

/** The `generated_image` rows of a Message. */
const imagesOf = (messageId: string) =>
  getTestDb().select().from(generatedImage).where(eq(generatedImage.messageId, messageId));

const offeredTools = (fake: ReturnType<typeof createFakeAdapter>) =>
  (fake.calls[0]?.tools ?? []).map((tool) => tool.name);

describe("the generate_image tool is offered", () => {
  it("when the Host's default Image Model is set", async () => {
    const { fake, send } = await setup({ rounds: [round(text("Sure."))] });

    await (await send()).text();

    expect(offeredTools(fake)).toContain("generate_image");
  });

  it("when the user picks an Image Model on their own key", async () => {
    const { user, deps, fake, send } = await setup({
      hostImage: false,
      rounds: [round(text("Sure."))],
    });
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-user-key" },
      hint: "…-key",
      verified: true,
    });
    await getTestDb()
      .insert(userSettings)
      .values({ userId: user.id, imageModel: "openai:gpt-image-1-mini" });

    await (await send()).text();

    expect(offeredTools(fake)).toContain("generate_image");
  });

  it("not when there is no usable Image Model", async () => {
    const { fake, send } = await setup({ hostImage: false, rounds: [round(text("Sure."))] });

    await (await send()).text();

    expect(offeredTools(fake)).not.toContain("generate_image");
  });
});

describe("the generate_image tool", () => {
  it("stores a done image part and a generated_image row, and the Model gets text only", async () => {
    const imageAdapter = fakeImageAdapter();
    const { deps, fake, conv, send } = await setup({
      imageAdapter,
      rounds: [
        round(
          text("Here goes."),
          imageCall("call-1", { prompt: "a red bicycle", aspectRatio: "landscape" }),
        ),
        round(text("Here it is.")),
      ],
    });

    await (await send()).text();

    const reply = await replyOf(deps, conv.id);
    expect(reply).toMatchObject({ status: "complete" });
    const rows = await imagesOf(reply.id);
    expect(rows).toEqual([
      expect.objectContaining({
        mediaType: "image/png",
        width: 1,
        height: 1,
        model: hostImageModel,
      }),
    ]);
    expect(reply.parts).toEqual(
      storedParts([
        { type: "text", text: "Here goes." },
        image({ aspectRatio: "landscape", state: "done", imageId: rows[0]!.id }),
        { type: "text", text: "Here it is." },
      ]),
    );
    // The Model's tool result names the image and its shape, with no pixels.
    const result = fake.calls[1]!.messages.at(-1)!;
    expect(result).toMatchObject({ role: "tool", toolCallId: "call-1" });
    expect(JSON.parse(result.content as string)).toEqual({
      imageId: rows[0]!.id,
      prompt: "a red bicycle",
      aspectRatio: "landscape",
    });
    expect(imageAdapter.calls).toEqual([{ prompt: "a red bicycle", size: "1024x1024" }]);
  });

  it("refuses a fifth image in one Run as limit_reached, and makes no fifth call", async () => {
    const imageAdapter = fakeImageAdapter();
    const { deps, conv, send } = await setup({
      imageAdapter,
      rounds: [
        round(
          imageCall("call-1", { prompt: "one" }),
          imageCall("call-2", { prompt: "two" }),
          imageCall("call-3", { prompt: "three" }),
          imageCall("call-4", { prompt: "four" }),
          imageCall("call-5", { prompt: "five" }),
        ),
        round(text("Done.")),
      ],
    });

    await (await send()).text();

    const reply = await replyOf(deps, conv.id);
    expect(imageAdapter.calls.map((call) => call.prompt)).toEqual(["one", "two", "three", "four"]);
    expect(reply.parts).toEqual(
      storedParts([
        image({ toolCallId: "call-1", prompt: "one", imageId: expect.any(String) }),
        image({ toolCallId: "call-2", prompt: "two", imageId: expect.any(String) }),
        image({ toolCallId: "call-3", prompt: "three", imageId: expect.any(String) }),
        image({ toolCallId: "call-4", prompt: "four", imageId: expect.any(String) }),
        image({
          toolCallId: "call-5",
          prompt: "five",
          state: "error",
          errorReason: "limit_reached",
        }),
        { type: "text", text: "Done." },
      ]),
    );
    expect(await imagesOf(reply.id)).toHaveLength(4);
  });

  it("fails an image that runs past the image timeout, and the Run carries on", async () => {
    const { deps, fake, conv, send } = await setup({
      imageAdapter: fakeImageAdapter({ delayMs: 500 }),
      deps: { limits: { imageTimeoutMs: 50 } },
      rounds: [round(imageCall("call-1", { prompt: "slow" })), round(text("It timed out."))],
    });

    await (await send()).text();

    const reply = await replyOf(deps, conv.id);
    expect(reply).toMatchObject({ status: "complete", error: null });
    expect(reply.parts).toEqual(
      storedParts([
        image({ prompt: "slow", state: "error", errorReason: "failed" }),
        { type: "text", text: "It timed out." },
      ]),
    );
    expect(await imagesOf(reply.id)).toEqual([]);
    expect(fake.calls).toHaveLength(2);
  });

  it("stops an image in progress as cancelled, storing no row", async () => {
    const { user, deps, conv, send } = await setup({
      imageAdapter: fakeImageAdapter({ delayMs: 60_000 }),
      rounds: [round(imageCall("call-1", { prompt: "stopped" })), round(text("Never."))],
    });
    const response = await send();
    await expect
      .poll(async () => (await replyOf(deps, conv.id)).parts, { interval: 10 })
      .toEqual(storedParts([image({ prompt: "stopped", state: "running" })]));
    const reply = await replyOf(deps, conv.id);

    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });

    await response.text();
    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "stopped",
      parts: storedParts([image({ prompt: "stopped", state: "cancelled" })]),
    });
    expect(await imagesOf(reply.id)).toEqual([]);
  });

  it("stores a refused image as refused, gives the Model the Provider's message, and the Run completes", async () => {
    const { deps, fake, conv, send } = await setup({
      imageAdapter: fakeImageAdapter({ refuse: "The Provider refused this prompt" }),
      rounds: [round(imageCall("call-1", { prompt: "not allowed" })), round(text("I can't."))],
    });

    await (await send()).text();

    expect(JSON.parse(fake.calls[1]!.messages.at(-1)!.content as string)).toEqual({
      error: "The Provider refused this prompt",
      reason: "refused",
    });
    const reply = await replyOf(deps, conv.id);
    expect(reply).toMatchObject({ status: "complete", error: null });
    expect(reply.parts).toEqual(
      storedParts([
        image({
          prompt: "not allowed",
          state: "error",
          errorReason: "refused",
        }),
        { type: "text", text: "I can't." },
      ]),
    );
  });
});

describe("generated images and their Conversation", () => {
  it("deletes a Conversation's generated_image rows with it", async () => {
    const { deps, conv, send } = await setup({
      rounds: [round(imageCall("call-1", { prompt: "a fox" })), round(text("Here."))],
    });
    await (await send()).text();
    const reply = await replyOf(deps, conv.id);
    expect(await imagesOf(reply.id)).toHaveLength(1);

    await getTestDb().delete(conversation).where(eq(conversation.id, conv.id));

    expect(await getTestDb().select().from(generatedImage)).toEqual([]);
  });
});

describe("a regenerated reply's images", () => {
  it("leave the old reply's images alone, and the new reply makes its own", async () => {
    const { deps, fake, conv, send } = await setup({
      rounds: [
        round(imageCall("call-1", { prompt: "first" })),
        round(text("One.")),
        round(imageCall("call-2", { prompt: "second" })),
        round(text("Two.")),
      ],
    });
    await (await send()).text();
    const [question, first] = await messagesOf(deps, conv.id);
    const firstRows = await imagesOf(first!.id);

    await (await send({ parentId: question!.id, text: undefined })).text();

    const second = await replyOf(deps, conv.id);
    expect(second.id).not.toBe(first!.id);
    expect(await imagesOf(first!.id)).toEqual(firstRows);
    expect(await imagesOf(second.id)).toHaveLength(1);
    expect(fake.calls).toHaveLength(4);
  });
});
