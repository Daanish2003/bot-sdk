import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { usage } from "../../../../core/server/storage";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import {
  fakeImageAdapter,
  fakePngBase64,
  quotaLookup,
} from "../../../../plugins/models/server/internal";
import type { HostProvider } from "../../../../plugins/models/server/internal";
import { inProcessRunner, type JobRunner } from "../../../../plugins/runner/server/internal";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { followSend } from "../../../support/follow-send";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../support/fake-computer-provider";

// Every test file here shares a worker with others: a generous test timeout and polling window.
const testTimeout = 30_000;

const hostModel = "anthropic:claude-sonnet-5-5";
const imageModelId = "openai:gpt-image-1-mini";
const silent = { error: () => {} };

const started: JobRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const hostProviders = (withImages: boolean, imageModel: string): HostProvider[] => [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host-secret-never-stored" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
  ...(withImages
    ? [
        {
          provider: "openai" as const,
          credentials: { apiKey: "sk-host-openai" },
          models: [],
          imageModels: [
            {
              modelId: imageModel,
              size: "1024x1024",
              quality: "medium",
              pricePerImageUsd: 0.04,
            },
          ],
        },
      ]
    : []),
];

type Rounds = Parameters<typeof createFakeAdapter>[0]["rounds"];

/** A Bot on a fake Computer under a Host with (or without) an Image Model, drawing with a fake adapter. */
async function botWith(
  rounds: Rounds,
  {
    images = true,
    withComputer = true,
    defaultImage = true,
    imageModel = "gpt-image-1-mini",
    imageAdapter = fakeImageAdapter(),
    ...overrides
  }: {
    images?: boolean;
    withComputer?: boolean;
    defaultImage?: boolean;
    imageModel?: string;
    imageAdapter?: ReturnType<typeof fakeImageAdapter>;
  } & Pick<TestDepsOverrides, "getQuota"> = {},
) {
  const computerFake = fakeComputerProvider({});
  const turnFake = createFakeAdapter({ rounds });
  const helperFake = createFakeAdapter({ rounds: [round(done)] });
  const adapter = {
    ...turnFake.adapter,
    chatStream: (options: TextOptions) =>
      (options.systemPrompts ?? []).some((prompt) =>
        (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
      )
        ? helperFake.adapter.chatStream(options)
        : turnFake.adapter.chatStream(options),
  } as typeof turnFake.adapter;
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    ...(withComputer && { computer: computerFake.provider }),
    jobs,
    adapterFor: () => adapter,
    imageAdapterFor: () => imageAdapter,
    hostProviders: hostProviders(images, imageModel),
    ...(images && defaultImage ? { defaultImageModel: `openai:${imageModel}` } : {}),
    ...overrides,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  const client = chatRpc({ user, deps });
  const created = await client.bots.create({ name: "Ada", model: hostModel });
  return {
    turnFake,
    helperFake,
    computerFake,
    imageAdapter,
    client,
    user,
    botId: created.id,
    deps,
  };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, message: string) {
  for await (const _ of await followSend(client, { botId, id: uuidv7(), text: message }));
}

const runTool = (name: string, args: Record<string, unknown>) =>
  toolCall({ name: "run_tool", input: { name, args } });
const draw = (args: { prompt: string; editPaths?: string[]; aspectRatio?: string }) =>
  runTool("generate_image", args);
const done = toolCall({ name: "send_to_user", input: { text: "ok", endTurn: true } });

const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];
const toolResults = (call: TextOptions | undefined) =>
  inputOf(call)
    .filter((entry) => entry.role === "tool")
    .map((entry) => JSON.parse(String(entry.content)));
const lastToolResult = (call: TextOptions | undefined) => toolResults(call).at(-1);
const usageOf = (userId: string) =>
  getTestDb().select().from(usage).where(eq(usage.userId, userId)).orderBy(asc(usage.createdAt));
const toolNames = (call: TextOptions | undefined) => (call?.tools ?? []).map((tool) => tool.name);

describe("generate_image", () => {
  it(
    "writes the image to the Computer under images/ and returns its path",
    async () => {
      const { client, botId, turnFake, computerFake, imageAdapter } = await botWith([
        round(draw({ prompt: "a red bicycle", aspectRatio: "landscape" })),
        round(done),
      ]);

      await send(client, botId, "draw a bicycle");

      const result = lastToolResult(turnFake.calls[1]);
      expect(result.path).toMatch(/^images\/[0-9a-f-]+\.png$/);
      const file = computerFake.files.get(`/home/user/bots/${botId}/${result.path}`);
      expect(file?.byteLength).toBeGreaterThan(0);
      expect(imageAdapter.calls).toHaveLength(1);
      expect(imageAdapter.calls[0]!.prompt).toBe("a red bicycle");
    },
    testTimeout,
  );

  it(
    "is a deferred tool: listed by name, not sent in the tools",
    async () => {
      const { client, botId, turnFake } = await botWith([round(done)]);

      await send(client, botId, "hi");

      expect(toolNames(turnFake.calls[0])).not.toContain("generate_image");
      expect(JSON.stringify(inputOf(turnFake.calls[0]))).toContain("generate_image");
    },
    testTimeout,
  );

  it(
    "edits an earlier image by its path, reading it from the Computer",
    async () => {
      const { client, botId, computerFake, imageAdapter } = await botWith([
        round(draw({ prompt: "make it blue", editPaths: ["images/seed.png"] })),
        round(done),
      ]);
      computerFake.files.set(
        `/home/user/bots/${botId}/images/seed.png`,
        new Uint8Array(Buffer.from(fakePngBase64, "base64")),
      );

      await send(client, botId, "recolour");

      expect(imageAdapter.calls).toHaveLength(1);
      const prompt = imageAdapter.calls[0]!.prompt as { type: string }[];
      expect(prompt.map((part) => part.type)).toEqual(["text", "image"]);
    },
    testTimeout,
  );

  it(
    "refuses edits on an Image Model that cannot edit",
    async () => {
      const { client, botId, turnFake, computerFake, imageAdapter } = await botWith(
        [round(draw({ prompt: "x", editPaths: ["images/a.png"] })), round(done)],
        { imageModel: "dall-e-3" },
      );
      computerFake.files.set(`/home/user/bots/${botId}/images/a.png`, new Uint8Array([1]));

      await send(client, botId, "edit");

      expect(lastToolResult(turnFake.calls[1]).error).toContain("can't edit");
      expect(imageAdapter.calls).toHaveLength(0);
    },
    testTimeout,
  );

  it(
    "refuses an edit of more than 4 images",
    async () => {
      const { client, botId, turnFake, imageAdapter } = await botWith([
        round(draw({ prompt: "x", editPaths: [1, 2, 3, 4, 5].map((n) => `images/${n}.png`) })),
        round(done),
      ]);

      await send(client, botId, "edit");

      expect(lastToolResult(turnFake.calls[1]).error).toContain("at most 4");
      expect(imageAdapter.calls).toHaveLength(0);
    },
    testTimeout,
  );

  it(
    "refuses an edit of a file that is not on the Computer, before any call",
    async () => {
      const { client, botId, turnFake, imageAdapter } = await botWith([
        round(draw({ prompt: "x", editPaths: ["images/missing.png"] })),
        round(done),
      ]);

      await send(client, botId, "edit");

      expect(lastToolResult(turnFake.calls[1]).error).toContain("images/missing.png");
      expect(imageAdapter.calls).toHaveLength(0);
    },
    testTimeout,
  );

  it(
    "refuses an edit of a GIF the user sent as one it can't edit, not as a file that isn't an image",
    async () => {
      const { client, botId, turnFake, computerFake, imageAdapter } = await botWith([
        round(draw({ prompt: "x", editPaths: ["uploads/cat.gif"] })),
        round(done),
      ]);
      computerFake.files.set(
        `/home/user/bots/${botId}/uploads/cat.gif`,
        new Uint8Array([...Buffer.from("GIF89a"), 1, 0, 1, 0]),
      );

      await send(client, botId, "edit");

      const { error } = lastToolResult(turnFake.calls[1]);
      expect(error).toContain("uploads/cat.gif is a GIF, which can't be edited");
      expect(error).not.toContain("not an image");
      expect(imageAdapter.calls).toHaveLength(0);
    },
    testTimeout,
  );

  it(
    "makes at most 4 images in a Turn",
    async () => {
      const { client, botId, turnFake, imageAdapter } = await botWith([
        round(draw({ prompt: "1" })),
        round(draw({ prompt: "2" })),
        round(draw({ prompt: "3" })),
        round(draw({ prompt: "4" })),
        round(draw({ prompt: "5" })),
        round(done),
      ]);

      await send(client, botId, "five images");

      expect(imageAdapter.calls).toHaveLength(4);
      expect(lastToolResult(turnFake.calls[5])).toEqual({ error: "image limit reached" });
    },
    testTimeout,
  );

  it(
    "tells the Bot to ask the user to pick an Image Model when none is usable",
    async () => {
      const { client, botId, turnFake, imageAdapter } = await botWith(
        [round(draw({ prompt: "a cat" })), round(done)],
        { defaultImage: false },
      );

      await send(client, botId, "a cat");

      expect(lastToolResult(turnFake.calls[1]).error).toBe(
        "No image Model: ask the user to pick one in Settings",
      );
      expect(imageAdapter.calls).toHaveLength(0);
    },
    testTimeout,
  );

  it(
    "refuses over the Quota before calling the Provider, and records only the first image",
    async () => {
      const { client, botId, turnFake, imageAdapter, user } = await botWith(
        [round(draw({ prompt: "one" })), round(draw({ prompt: "two" })), round(done)],
        // 30,000 micros a day: the model calls fit, and the first image (40,000) spends it.
        { getQuota: quotaLookup({ budgetUsd: 0.03, window: "day" }) },
      );

      await send(client, botId, "two images");

      expect(imageAdapter.calls.map((call) => call.prompt)).toEqual(["one"]);
      expect(lastToolResult(turnFake.calls[2]).error).toContain("Quota");
      expect((await usageOf(user.id)).filter((row) => row.kind === "image")).toHaveLength(1);
    },
    testTimeout,
  );

  it(
    "records the Host's price for the image in the same Checkpoint",
    async () => {
      const { client, botId, user } = await botWith([
        round(draw({ prompt: "a cat" })),
        round(done),
      ]);

      await send(client, botId, "a cat");

      const rows = (await usageOf(user.id)).filter((row) => row.kind === "image");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe(imageModelId);
      expect(rows[0]!.costMicros).toBe(40_000);
    },
    testTimeout,
  );

  it(
    "is absent without a Computer, and without Host Image Models",
    async () => {
      const noComputer = await botWith([round(done)], { withComputer: false });
      await send(noComputer.client, noComputer.botId, "hi");
      expect(JSON.stringify(inputOf(noComputer.turnFake.calls[0]))).not.toContain("generate_image");

      const noImages = await botWith([round(done)], { images: false });
      await send(noImages.client, noImages.botId, "hi");
      expect(JSON.stringify(inputOf(noImages.turnFake.calls[0]))).not.toContain("generate_image");
    },
    testTimeout,
  );

  it(
    "is not a Helper's tool",
    async () => {
      const { client, botId, helperFake } = await botWith([
        round(toolCall({ name: "start_helper", input: { type: "general", task: "draw a cat" } })),
        round(done),
      ]);

      await send(client, botId, "delegate");

      await expect.poll(() => helperFake.calls.length, { timeout: 10_000 }).toBeGreaterThan(0);
      expect(JSON.stringify(helperFake.calls[0]!.tools ?? [])).not.toContain("generate_image");
    },
    testTimeout,
  );
});
