import { storedParts, type GeneratedImagePart } from "../../../../core/shared/message-parts";
import {
  generatedImage,
  conversation,
  message,
  usage,
  userSettings,
  blob,
} from "../../../../core/server/db/schema";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveCredentials } from "../../../../core/server/credentials/store";
import type { AppDeps, HostProvider } from "../../../../core/server/deps";
import { fakeImageAdapter, fakePngBase64 } from "../../../../core/server/chat/fake-image-adapter";
import { like } from "drizzle-orm";
import { quotaLookup, readQuota } from "../../../../core/server/chat/quota";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { insertConversation, insertMessage } from "../../../support/conversations";
import { insertGeneratedImage } from "../../../support/generated-images";
import { insertAttachment, linkTestAttachments } from "../../../support/attachments";
import { createTestSdk, type TestDepsOverrides } from "../../../support/deps";
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
  const deps = createTestSdk({
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

  it("not when no image adapter serves the Image Model, and the reply completes as before", async () => {
    const { deps, fake, conv, send } = await setup({
      deps: { imageAdapterFor: () => undefined },
      rounds: [round(text("Sure."))],
    });

    await (await send()).text();

    expect(offeredTools(fake)).not.toContain("generate_image");
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete", error: null });
  });

  it("not when the Provider has no image adapter, and the reply still completes", async () => {
    const { deps, fake, conv, send } = await setup({
      deps: {
        imageAdapterFor: () => {
          throw new Error("No image adapter is available for the anthropic Provider");
        },
      },
      rounds: [round(text("Sure."))],
    });

    await (await send()).text();

    expect(offeredTools(fake)).not.toContain("generate_image");
    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete", error: null });
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
    // The bytes are kept in the blob store under the image's id, next to its row (spec #278).
    const stored = await deps.blobStore.get(`generated-image/${rows[0]!.id}`);
    expect(Uint8Array.from(stored!)).toEqual(new Uint8Array(Buffer.from(fakePngBase64, "base64")));
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
    // The Run ends without waiting for the tool, so let a call still in flight settle before looking.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await imagesOf(reply.id)).toEqual([]);
    // No bytes either: a stopped image is never stored (spec #278).
    expect(
      await getTestDb().select().from(blob).where(like(blob.key, "generated-image/%")),
    ).toEqual([]);
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

describe("the Host's pricing of generated images", () => {
  /** The `chat.usage` rows of kind `image` of the user, oldest first (the Run's own rows are left out). */
  async function imageUsageOf(userId: string) {
    const rows = await getTestDb()
      .select({
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros: usage.costMicros,
        estimated: usage.estimated,
      })
      .from(usage)
      .where(eq(usage.userId, userId))
      .orderBy(asc(usage.createdAt));
    return rows.filter((row) => row.model !== anthropicModel);
  }

  /** The Run's spend, written directly, so the Quota is near its budget before the Run starts. */
  async function spend(userId: string, costMicros: number) {
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId,
      kind: "run",
      model: anthropicModel,
      inputTokens: 0,
      outputTokens: 0,
      costMicros,
      estimated: false,
      createdAt: new Date(),
    });
  }

  it("records a reported cost as it is", async () => {
    const { user, send } = await setup({
      imageAdapter: fakeImageAdapter({ usage: { cost: 0.0123 } }),
      rounds: [round(imageCall("call-1", { prompt: "priced" })), round(text("Done."))],
    });

    await (await send()).text();

    expect(await imageUsageOf(user.id)).toEqual([
      {
        model: hostImageModel,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 12_300,
        estimated: false,
      },
    ]);
  });

  it("prices reported tokens with the Host's image token prices", async () => {
    const { user, send } = await setup({
      deps: {
        hostProviders: [
          {
            provider: "openai",
            credentials: { apiKey: "host-openai-key" },
            models: [],
            imageModels: [
              {
                modelId: "gpt-image-1-mini",
                size: "1024x1024",
                quality: "medium",
                pricePerImageUsd: 0.01,
                imageInputPerMTok: 10,
                textInputPerMTok: 5,
                imageOutputPerMTok: 40,
              },
            ],
          },
        ],
      },
      imageAdapter: fakeImageAdapter({
        usage: { promptTokens: 1_000, completionTokens: 500, imageTokens: 200, textTokens: 800 },
      }),
      rounds: [round(imageCall("call-1", { prompt: "tokens" })), round(text("Done."))],
    });

    await (await send()).text();

    // 200 image input tokens at 10, 800 text input at 5 and 500 output at 40, in micros.
    expect(await imageUsageOf(user.id)).toEqual([
      {
        model: hostImageModel,
        inputTokens: 1_000,
        outputTokens: 500,
        costMicros: 26_000,
        estimated: false,
      },
    ]);
  });

  it("falls back to pricePerImageUsd, estimated, when the Provider reports no usage, one row per image", async () => {
    const { user, deps, conv, send } = await setup({
      imageAdapter: fakeImageAdapter(),
      rounds: [
        round(imageCall("call-1", { prompt: "one" }), imageCall("call-2", { prompt: "two" })),
        round(text("Done.")),
      ],
    });

    await (await send()).text();

    expect(await replyOf(deps, conv.id)).toMatchObject({ status: "complete" });
    expect(await imageUsageOf(user.id)).toEqual([
      {
        model: hostImageModel,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 10_000,
        estimated: true,
      },
      {
        model: hostImageModel,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 10_000,
        estimated: true,
      },
    ]);
  });

  it("records nothing for a refused image that reported no usage", async () => {
    const { user, send } = await setup({
      imageAdapter: fakeImageAdapter({ refuse: "Refused" }),
      rounds: [round(imageCall("call-1", { prompt: "no" })), round(text("I can't."))],
    });

    await (await send()).text();

    expect(await imageUsageOf(user.id)).toEqual([]);
  });

  it("records the flat price, estimated, for a stopped call on an adapter that doesn't cancel upstream", async () => {
    const { user, deps, conv, send } = await setup({
      imageAdapter: fakeImageAdapter({ delayMs: 300, ignoresAbort: true }),
      rounds: [round(imageCall("call-1", { prompt: "stopped" })), round(text("Never."))],
    });
    const response = await send();
    await expect
      .poll(async () => (await replyOf(deps, conv.id)).parts, { interval: 10 })
      .toEqual(storedParts([image({ prompt: "stopped", state: "running" })]));
    const reply = await replyOf(deps, conv.id);

    await chatRpc({ user, deps }).chat.stop({ messageId: reply.id });
    await response.text();

    // The Provider finishes the call after the Run has stopped, so its price lands a little later.
    await expect
      .poll(() => imageUsageOf(user.id), { interval: 20 })
      .toEqual([
        {
          model: hostImageModel,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 10_000,
          estimated: true,
        },
      ]);
    expect(await imagesOf(reply.id)).toEqual([]);
  });

  it("records nothing for a stopped call on an adapter that cancels upstream", async () => {
    const { user, deps, conv, send } = await setup({
      deps: {
        hostProviders: [
          {
            provider: "gemini",
            credentials: { apiKey: "host-gemini-key" },
            models: [],
            imageModels: [
              {
                modelId: "gemini-3.1-flash-image",
                size: "1024x1024",
                quality: "medium",
                pricePerImageUsd: 0.01,
              },
            ],
          },
        ],
        defaultImageModel: "gemini:gemini-3.1-flash-image",
      },
      imageAdapter: fakeImageAdapter({ delayMs: 60_000 }),
      rounds: [round(imageCall("call-1", { prompt: "stopped" })), round(text("Never."))],
    });
    const response = await send();
    await expect
      .poll(async () => (await replyOf(deps, conv.id)).parts, { interval: 10 })
      .toEqual(storedParts([image({ prompt: "stopped", state: "running" })]));

    await chatRpc({ user, deps }).chat.stop({ messageId: (await replyOf(deps, conv.id)).id });
    await response.text();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await imageUsageOf(user.id)).toEqual([]);
  });

  it("refuses the second image once the window is over the budget, and the Run completes", async () => {
    // 5,000 of the 10,000 budget is spent: the first image fits, and its 10,000 takes it over.
    const { user, deps, conv, send } = await setup({
      imageAdapter: fakeImageAdapter(),
      deps: { getQuota: quotaLookup({ budgetUsd: 0.01, window: "day" }) },
      rounds: [
        round(imageCall("call-1", { prompt: "first" })),
        round(imageCall("call-2", { prompt: "second" })),
        round(text("Done.")),
      ],
    });
    await spend(user.id, 5_000);

    await (await send()).text();

    const reply = await replyOf(deps, conv.id);
    expect(reply).toMatchObject({ status: "complete", error: null });
    expect(reply.parts).toEqual(
      storedParts([
        image({ toolCallId: "call-1", prompt: "first", imageId: expect.any(String) }),
        image({
          toolCallId: "call-2",
          prompt: "second",
          state: "error",
          errorReason: "quota_exceeded",
        }),
        { type: "text", text: "Done." },
      ]),
    );
    expect(await imageUsageOf(user.id)).toEqual([
      {
        model: hostImageModel,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 10_000,
        estimated: true,
      },
    ]);
  });

  it("counts an image in the Quota read, as a percentage", async () => {
    const { user, deps, send } = await setup({
      imageAdapter: fakeImageAdapter(),
      deps: { getQuota: quotaLookup({ budgetUsd: 0.02, window: "day" }) },
      rounds: [round(imageCall("call-1", { prompt: "one" })), round(text("Done."))],
    });

    await (await send()).text();

    expect(await readQuota(deps, user.id)).toMatchObject({ usedPercent: 50, window: "day" });
  });

  it("gives a BYOK image no Host cost, and the Host's Quota doesn't refuse it", async () => {
    const { user, deps, conv, fake, send } = await setup({
      hostImage: false,
      imageAdapter: fakeImageAdapter(),
      deps: { getQuota: quotaLookup({ budgetUsd: 0.0001, window: "day" }) },
      rounds: [round(imageCall("call-1", { prompt: "mine" })), round(text("Done."))],
    });
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-user-key" },
      hint: "…-key",
      verified: true,
    });
    await getTestDb().insert(userSettings).values({ userId: user.id, imageModel: hostImageModel });
    await spend(user.id, 50_000);

    await (await send()).text();

    expect(await replyOf(deps, conv.id)).toMatchObject({
      status: "complete",
      parts: storedParts([
        image({ prompt: "mine", state: "done", imageId: expect.any(String) }),
        { type: "text", text: "Done." },
      ]),
    });
    expect(fake.calls).toHaveLength(2);
    expect(await imageUsageOf(user.id)).toEqual([
      { model: hostImageModel, inputTokens: 0, outputTokens: 0, costMicros: 0, estimated: false },
    ]);
  });
});

describe("editing a generated image", () => {
  const editCall = (id: string, input: { prompt: string; editImageIds: string[] }) =>
    toolCall({ id, name: "generate_image", input });

  /** The Message whose reply made the image `imageId`. */
  async function messageOfImage(imageId: string) {
    const [row] = await getTestDb()
      .select()
      .from(generatedImage)
      .where(eq(generatedImage.id, imageId));
    return row!.messageId;
  }

  /** The `generated_image` row of `imageId`, as stored. */
  const rowOf = async (imageId: string) =>
    (await getTestDb().select().from(generatedImage).where(eq(generatedImage.id, imageId)))[0];

  const pngBase64 = fakePngBase64;
  const pngPart = (base64: string) => ({
    type: "image",
    source: { type: "data", value: base64, mimeType: "image/png" },
  });

  it("passes an earlier Generated image's bytes to the adapter, and stores a new image with editedFrom", async () => {
    const imageAdapter = fakeImageAdapter();
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { user, deps, conv, send } = await setup({ imageAdapter, rounds });
    const source = await insertGeneratedImage(deps, user, conv.id, { prompt: "a red bicycle" });
    rounds.push(
      round(editCall("call-1", { prompt: "a bluer bicycle", editImageIds: [source] })),
      round(text("Bluer.")),
    );

    await (await send({ parentId: await messageOfImage(source), text: "make it bluer" })).text();

    const reply = await replyOf(deps, conv.id);
    const rows = await imagesOf(reply.id);
    expect(reply).toMatchObject({ status: "complete" });
    expect(rows).toHaveLength(1);
    expect(reply.parts).toEqual(
      storedParts([
        image({
          toolCallId: "call-1",
          prompt: "a bluer bicycle",
          state: "done",
          imageId: rows[0]!.id,
          editedFrom: [source],
        }),
        { type: "text", text: "Bluer." },
      ]),
    );
    // The adapter gets the edit's text, then the source's bytes as an image part.
    expect(imageAdapter.calls).toEqual([
      {
        prompt: [{ type: "text", content: "a bluer bicycle" }, pngPart(pngBase64)],
        size: "1024x1024",
      },
    ]);
  });

  it("can edit an image Attachment on the path", async () => {
    const imageAdapter = fakeImageAdapter();
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { user, deps, conv, send } = await setup({ imageAdapter, rounds });
    const photo = await insertAttachment(user, {
      filename: "photo.png",
      mediaType: "image/png",
      contents: Buffer.from(pngBase64, "base64"),
    });
    const upload = await insertMessage({
      conversationId: conv.id,
      role: "user",
      text: "Here is my photo",
    });
    await linkTestAttachments(upload.id, [photo.id]);
    rounds.push(
      round(editCall("call-1", { prompt: "rework it", editImageIds: [photo.id] })),
      round(text("Done.")),
    );

    await (await send({ parentId: upload.id, text: "rework my photo" })).text();

    const reply = await replyOf(deps, conv.id);
    expect(reply.parts).toEqual(
      storedParts([
        image({
          toolCallId: "call-1",
          prompt: "rework it",
          state: "done",
          imageId: expect.any(String),
          editedFrom: [photo.id],
        }),
        { type: "text", text: "Done." },
      ]),
    );
    expect(imageAdapter.calls[0]!.prompt).toEqual([
      { type: "text", content: "rework it" },
      pngPart(pngBase64),
    ]);
  });

  it("fails an id from a sibling Branch as failed, and makes no image", async () => {
    const imageAdapter = fakeImageAdapter();
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { user, deps, conv, send } = await setup({ imageAdapter, rounds });
    const sibling = await insertGeneratedImage(deps, user, conv.id, { prompt: "sibling" });
    const branch = await insertGeneratedImage(deps, user, conv.id, { prompt: "this branch" });
    rounds.push(
      round(editCall("call-1", { prompt: "bluer", editImageIds: [sibling] })),
      round(text("I can't.")),
    );

    await (await send({ parentId: await messageOfImage(branch), text: "bluer" })).text();

    expect(imageAdapter.calls).toEqual([]);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      parts: storedParts([
        image({ toolCallId: "call-1", prompt: "bluer", state: "error", errorReason: "failed" }),
        { type: "text", text: "I can't." },
      ]),
    });
  });

  it("fails an id of another user's image as failed, even on the path", async () => {
    const imageAdapter = fakeImageAdapter();
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { user, deps, conv, send } = await setup({ imageAdapter, rounds });
    const other = await insertUser();
    const theirs = await insertGeneratedImage(deps, other, conv.id, { prompt: "theirs" });
    rounds.push(
      round(editCall("call-1", { prompt: "bluer", editImageIds: [theirs] })),
      round(text("I can't.")),
    );

    await (await send({ parentId: await messageOfImage(theirs), text: "bluer" })).text();

    expect(user.id).not.toBe(other.id);
    expect(imageAdapter.calls).toEqual([]);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      parts: storedParts([
        image({ toolCallId: "call-1", prompt: "bluer", state: "error", errorReason: "failed" }),
        { type: "text", text: "I can't." },
      ]),
    });
  });

  it("refuses more ids than min(maxInputImages, 4) as too_many_images", async () => {
    const imageAdapter = fakeImageAdapter();
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { user, deps, conv, send } = await setup({ imageAdapter, rounds });
    const ids: string[] = [];
    let parentId: string | null = null;
    for (let index = 0; index < 5; index++) {
      const id = await insertGeneratedImage(deps, user, conv.id, {
        prompt: `image ${index}`,
        parentId,
      });
      ids.push(id);
      parentId = await messageOfImage(id);
    }
    rounds.push(
      round(editCall("call-1", { prompt: "all of them", editImageIds: ids })),
      round(text("Too many.")),
    );

    await (await send({ parentId, text: "combine these" })).text();

    expect(imageAdapter.calls).toEqual([]);
    expect(await replyOf(deps, conv.id)).toMatchObject({
      parts: storedParts([
        image({
          toolCallId: "call-1",
          prompt: "all of them",
          state: "error",
          errorReason: "too_many_images",
        }),
        { type: "text", text: "Too many." },
      ]),
    });
  });

  it("leaves the source's row and bytes as they were", async () => {
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { user, deps, conv, send } = await setup({ imageAdapter: fakeImageAdapter(), rounds });
    const source = await insertGeneratedImage(deps, user, conv.id);
    const before = await rowOf(source);
    rounds.push(
      round(editCall("call-1", { prompt: "edit", editImageIds: [source] })),
      round(text("Done.")),
    );

    await (await send({ parentId: await messageOfImage(source), text: "edit it" })).text();

    expect(await rowOf(source)).toEqual(before);
    expect(Uint8Array.from((await deps.blobStore.get(`generated-image/${source}`))!)).toEqual(
      new Uint8Array(Buffer.from(pngBase64, "base64")),
    );
  });

  it("tells the Model which image Attachments on the path it can name", async () => {
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { user, conv, fake, send } = await setup({
      imageAdapter: fakeImageAdapter(),
      rounds,
    });
    const photo = await insertAttachment(user, {
      filename: "photo.png",
      mediaType: "image/png",
      contents: Buffer.from(pngBase64, "base64"),
    });
    const upload = await insertMessage({ conversationId: conv.id, role: "user", text: "Look" });
    await linkTestAttachments(upload.id, [photo.id]);
    rounds.push(round(text("Sure.")));

    await (await send({ parentId: upload.id, text: "what is it" })).text();

    expect(JSON.stringify(fake.calls[0]!.messages)).toContain(`[Attachment id: ${photo.id}]`);
  });

  it("is not offered as edits when the Image Model can't edit, and the schema says so", async () => {
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { fake, send } = await setup({
      rounds,
      deps: {
        hostProviders: [
          {
            provider: "gemini",
            credentials: { apiKey: "host-gemini-key" },
            models: [],
            imageModels: [
              {
                modelId: "gemini-3.1-flash-image",
                size: "1024x1024",
                quality: "medium",
                pricePerImageUsd: 0.01,
              },
            ],
          },
        ],
        defaultImageModel: "gemini:gemini-3.1-flash-image",
      },
    });
    rounds.push(round(text("Sure.")));

    await (await send()).text();

    const tool = fake.calls[0]!.tools!.find((candidate) => candidate.name === "generate_image")!;
    expect(JSON.stringify(tool.inputSchema)).not.toContain("editImageIds");
    expect(tool.description).toContain("aren't supported");
  });

  it("is offered as edits when the Image Model can edit", async () => {
    const rounds: Parameters<typeof setup>[0]["rounds"] = [];
    const { fake, send } = await setup({ rounds });
    rounds.push(round(text("Sure.")));

    await (await send()).text();

    const tool = fake.calls[0]!.tools!.find((candidate) => candidate.name === "generate_image")!;
    expect(JSON.stringify(tool.inputSchema)).toContain("editImageIds");
  });
});
