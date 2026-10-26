import type { AnyTextAdapter, ModelMessage, TextOptions } from "@tanstack/ai";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { blob, botHelper, botReview, jobEvent } from "../../../../core/server/storage";
import { deleteUserData } from "../../../../core/server/user-data";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import {
  noVisionError,
  botHelperJob,
  computerUseHelperPrompt,
  helperEndings,
  helperTimeLimitMs,
} from "../../../../plugins/bot/server/helpers";
import { keptScreenshots, removedScreenshot } from "../../../../plugins/bot/server/conversation";

import {
  reapStaleJobs,
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../../plugins/runner/server/internal";
import type { ReviewVerdict } from "../../../../plugins/bot/server/safety";
import type { CommandResult } from "../../../../plugins/computer/server/internal";
import { saveCredentials } from "../../../../plugins/models/server/internal";
import type { HostProvider } from "../../../../plugins/models/server/internal";

import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { fakeReviewer, passVerdict, verdictRound } from "../../../support/fake-reviewer";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { type FakeCommandRun, fakeComputerProvider } from "../../../support/fake-computer-provider";
import { followSend } from "../../../support/follow-send";

const silent = { error: () => {} };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const isHelperCall = (options: TextOptions) =>
  (options.systemPrompts ?? []).some((prompt) =>
    (typeof prompt === "string" ? prompt : prompt.content).startsWith("You are a Helper"),
  );

/**
 * A user whose Bot runs on `model`, over `computer` with a fake provider that photographs `shot`
 * and answers every other command with `onCommand`.
 */
async function userWith(
  model: string,
  turns: Round[],
  helpers: Round[],
  {
    shot = png,
    hostProviders = [],
    reviewer = fakeReviewer(),
    onCommand = () => ({ exitCode: 0, stdout: "", stderr: "" }),
    onShot = async () => {},
    clock = () => new Date(),
  }: {
    shot?: Uint8Array;
    hostProviders?: HostProvider[];
    reviewer?: ReturnType<typeof fakeReviewer>;
    onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult>;
    /** Runs before each screenshot lands. */
    onShot?: () => Promise<void>;
    /** The SDK's and the runner's clock: a test moves it past an Approval's deadline. */
    clock?: () => Date;
  } = {},
) {
  const turnFake = createFakeAdapter({ rounds: turns });
  const helperFake = createFakeAdapter({ rounds: helpers });
  const adapter = {
    ...turnFake.adapter,
    chatStream: async function* (options: TextOptions) {
      if (!isHelperCall(options)) return yield* turnFake.adapter.chatStream(options);
      yield* helperFake.adapter.chatStream(options);
    },
  } as AnyTextAdapter;
  const computerFake = fakeComputerProvider({
    // A screenshot lands where `scrot` was told to write it.
    onCommand: async (run) => {
      const path = run.command.match(/scrot -o (\S+)$/)?.[1];
      if (path) {
        await onShot();
        computerFake.files.set(path, shot);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return onCommand(run);
    },
  });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: { ...systemClock, now: clock },
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    jobs,
    clock,
    adapterFor: () => adapter,
    reviewAdapterFor: () => reviewer.adapter,
    hostProviders,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  const provider = model.split(":")[0]!;
  if (hostProviders.length === 0) {
    await saveCredentials(deps, user.id, {
      service: provider as "openai",
      fields: { apiKey: `${provider}-test-key` },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const botId = (await client.bot.create({ name: "Ada", model })).id;
  return { helperFake, computerFake, reviewer, client, botId, deps, user };
}

const startComputerUse = toolCall({
  name: "start_helper",
  input: { type: "computer_use", task: "Use the desktop." },
});

const handsOff = round(
  startComputerUse,
  toolCall({ name: "send_to_user", input: { text: "On it.", endTurn: true } }),
);

/** A call of the computer tool, in the input shape of Anthropic's or OpenAI's native tool. */
const computerCall = (input: object) => toolCall({ name: "computer", input });

const helpersOf = (botId: string) =>
  getTestDb().select().from(botHelper).where(eq(botHelper.botId, botId));

async function sent(client: ReturnType<typeof chatRpc>, botId: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: "go" }));
}

async function ran(client: ReturnType<typeof chatRpc>, botId: string) {
  await sent(client, botId);
  await expect
    .poll(async () => (await helpersOf(botId)).every((row) => row.status !== "running"), {
      timeout: 20_000,
    })
    .toBe(true);
  const [helper] = await getTestDb()
    .select()
    .from(botHelper)
    .where(eq(botHelper.botId, botId))
    .orderBy(asc(botHelper.startedAt));
  return helper!;
}

/** The tool messages of a model call's input. */
const toolMessages = (options: TextOptions) =>
  (options.messages as ModelMessage[]).filter((entry) => entry.role === "tool");

const imagesIn = (message: ModelMessage) =>
  Array.isArray(message.content) ? message.content.filter((part) => part.type === "image") : [];

/** The commands that drove the Screen, in order. */
const screenCommands = (computerFake: ReturnType<typeof fakeComputerProvider>) =>
  computerFake
    .callsOf("run")
    .map((call) => call.command)
    .filter(
      (command) =>
        command.includes("xdotool") || command.includes("scrot") || command.startsWith("sleep "),
    );

const shot = "sleep 0.5 && DISPLAY=:1 scrot -o /tmp/screens/1/desktop.png";

const reviewsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botReview)
    .where(eq(botReview.botId, botId))
    .orderBy(asc(botReview.createdAt));

describe("a Computer-use Helper's computer tool", () => {
  it("runs each action as xdotool on its Screen's display and returns a screenshot", async () => {
    const { client, botId, helperFake, computerFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [
        // Anthropic's actions.
        round(computerCall({ action: "left_click", coordinate: [10, 20] })),
        round(computerCall({ action: "right_click", coordinate: [30, 40] })),
        round(computerCall({ action: "double_click", coordinate: [50, 60] })),
        round(computerCall({ action: "mouse_move", coordinate: [70, 80] })),
        round(
          computerCall({ action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] }),
        ),
        round(computerCall({ action: "type", text: "it's" })),
        round(computerCall({ action: "key", text: "ctrl+a" })),
        round(
          computerCall({
            action: "scroll",
            coordinate: [5, 6],
            scroll_direction: "down",
            scroll_amount: 3,
          }),
        ),
        round(computerCall({ action: "screenshot" })),
        // OpenAI's: one action, then a batch.
        round(computerCall({ action: { type: "keypress", keys: ["ENTER"] } })),
        round(
          computerCall({
            actions: [
              { type: "click", button: "left", x: 7, y: 8 },
              { type: "type", text: "hi" },
            ],
          }),
        ),
        // A key xdotool names otherwise.
        round(computerCall({ action: { type: "keypress", keys: ["CTRL", "/"] } })),
        // A wait and a held key run on the Computer, so a Stop cuts them short.
        round(computerCall({ action: "wait", duration: 2 })),
        round(computerCall({ action: "hold_key", text: "shift", duration: 1 })),
        // The cursor's position, and a click with no coordinate, which clicks there.
        round(computerCall({ action: "cursor_position" })),
        round(computerCall({ action: "left_click" })),
        // Zoom is off, so it can't run.
        round(computerCall({ action: "zoom", region: [0, 0, 10, 10] })),
        round(text("Done.")),
      ],
      {
        onCommand: ({ command }) => ({
          exitCode: 0,
          stdout: command.includes("getmouselocation") ? "X=11\nY=22\nSCREEN=0\nWINDOW=3\n" : "",
          stderr: "",
        }),
      },
    );

    const helper = await ran(client, botId);

    expect(helper).toMatchObject({ status: "complete", report: "Done." });
    expect(helperFake.calls[0]?.systemPrompts).toEqual([computerUseHelperPrompt]);
    expect(computerUseHelperPrompt).toContain(
      "Use `computer` only for what the browser can't reach",
    );
    // The portable tool: each direct Provider's adapter swaps in its native computer tool.
    const tool = (helperFake.calls[0]?.tools ?? []).find((entry) => entry.name === "computer");
    expect(tool?.metadata).toMatchObject({
      __kind: "computer_use",
      display: { width: 1280, height: 800 },
      environment: "linux",
      capabilities: { zoom: false, cursorPosition: true },
    });
    expect((helperFake.calls[0]?.tools ?? []).map((entry) => entry.name)).not.toContain("desktop");
    expect(screenCommands(computerFake)).toEqual([
      "DISPLAY=:1 xdotool mousemove 10 20 click 1",
      shot,
      "DISPLAY=:1 xdotool mousemove 30 40 click 3",
      shot,
      "DISPLAY=:1 xdotool mousemove 50 60 click --repeat 2 --delay 100 1",
      shot,
      "DISPLAY=:1 xdotool mousemove 70 80",
      shot,
      "DISPLAY=:1 xdotool mousemove 1 2",
      "DISPLAY=:1 xdotool mousedown 1",
      "DISPLAY=:1 xdotool mousemove 3 4",
      "DISPLAY=:1 xdotool mouseup 1",
      shot,
      "DISPLAY=:1 xdotool type --delay 12 -- 'it'\\''s'",
      shot,
      "DISPLAY=:1 xdotool key -- 'ctrl+a'",
      shot,
      "DISPLAY=:1 xdotool mousemove 5 6 click --repeat 3 5",
      shot,
      shot,
      "DISPLAY=:1 xdotool key -- 'Return'",
      shot,
      "DISPLAY=:1 xdotool mousemove 7 8 click 1",
      "DISPLAY=:1 xdotool type --delay 12 -- 'hi'",
      shot,
      "DISPLAY=:1 xdotool key -- 'ctrl+slash'",
      shot,
      "sleep 2",
      shot,
      "DISPLAY=:1 xdotool keydown -- 'shift' && sleep 1",
      "DISPLAY=:1 xdotool keyup -- 'shift'",
      shot,
      "DISPLAY=:1 xdotool getmouselocation --shell",
      shot,
      "DISPLAY=:1 xdotool getmouselocation --shell",
      "DISPLAY=:1 xdotool mousemove 11 22 click 1",
      shot,
    ]);
    // Each action's result is the screenshot as an image part; the zoom is an error the Model reads.
    const results = toolMessages(helperFake.calls.at(-1)!);
    expect(results).toHaveLength(17);
    expect(JSON.stringify(results.at(-3)?.content)).toContain("X=11,Y=22");
    expect(imagesIn(results.at(-2)!)).toEqual([
      {
        type: "image",
        source: { type: "data", value: Buffer.from(png).toString("base64"), mimeType: "image/png" },
      },
    ]);
    expect(results.at(-1)?.error).toContain('"zoom" action is not available');
    expect(imagesIn(results.at(-1)!)).toEqual([]);
  }, 60_000);

  it("keeps only the newest 3 screenshots in the next model input", async () => {
    const { client, botId, helperFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [
        ...Array.from({ length: 5 }, () => round(computerCall({ action: "screenshot" }))),
        round(text("Looked.")),
      ],
    );

    await ran(client, botId);

    // The sixth call's input has five tool results.
    const input = toolMessages(helperFake.calls.at(-1)!);
    const withImages = input.filter((entry) => imagesIn(entry).length > 0);
    expect(input).toHaveLength(5);
    expect(withImages).toHaveLength(keptScreenshots);
    expect(input.slice(0, 2).map((entry) => JSON.stringify(entry.content))).toEqual(
      [0, 1].map(() => expect.stringContaining(removedScreenshot)),
    );
    // The call before it still had all but the oldest.
    const before = toolMessages(helperFake.calls.at(-2)!);
    expect(before.filter((entry) => imagesIn(entry).length > 0)).toHaveLength(keptScreenshots);
  }, 60_000);

  it("stores each screenshot once: the transcript and the Checkpoints hold refs", async () => {
    // About 300 KB of base64 a screenshot, like a real 1280x800 PNG.
    const big = new Uint8Array(225_000).map((_, i) => (i * 31 + 7) % 251);
    const { client, botId, helperFake, deps, user } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [
        ...Array.from({ length: 5 }, () => round(computerCall({ action: "screenshot" }))),
        round(text("Looked.")),
      ],
      { shot: big },
    );

    const helper = await ran(client, botId);

    expect(helper.status).toBe("complete");
    const base64 = Buffer.from(big).toString("base64");
    expect(base64.length).toBe(300_000);
    const transcript = JSON.stringify(helper.transcript);
    expect(transcript).not.toContain(base64.slice(0, 100));
    expect(transcript.length).toBeLessThan(5_000);
    const computerResults = (
      await getTestDb()
        .select({ result: jobEvent.result })
        .from(jobEvent)
        .where(
          and(
            eq(jobEvent.jobId, helper.jobId!),
            inArray(jobEvent.name, ["computer", "computer:screenshot"]),
          ),
        )
    ).map((row) => JSON.stringify(row.result));
    expect(computerResults).toHaveLength(10);
    for (const result of computerResults) expect(result.length).toBeLessThan(500);
    // Each screenshot is in the blob store once.
    const stored = await getTestDb()
      .select({ bytes: blob.bytes })
      .from(blob)
      .where(like(blob.key, "screenshot/%"));
    expect(stored).toHaveLength(5);
    for (const row of stored) expect(Buffer.from(row.bytes).equals(Buffer.from(big))).toBe(true);
    // The Model still receives the newest screenshots as images.
    const images = toolMessages(helperFake.calls.at(-1)!).flatMap(imagesIn);
    expect(images).toEqual(
      Array.from({ length: keptScreenshots }, () => ({
        type: "image",
        source: { type: "data", value: base64, mimeType: "image/png" },
      })),
    );

    // They go with their user.
    await deleteUserData(deps, user.id);

    const left = await getTestDb()
      .select({ key: blob.key })
      .from(blob)
      .where(like(blob.key, "screenshot/%"));
    expect(left).toEqual([]);
  }, 60_000);

  it("is present on a model without image input and says it can't see, with no review", async () => {
    const { client, botId, helperFake, computerFake, reviewer } = await userWith(
      "anthropic:claude-text-only",
      [handsOff, round()],
      [round(computerCall({ action: "left_click", coordinate: [1, 1] })), round(text("Blind."))],
      {
        // A Host Model that can run a Computer-use Helper but has no image input.
        hostProviders: [
          {
            provider: "anthropic",
            credentials: { apiKey: "sk-host" },
            models: [
              {
                modelId: "claude-text-only",
                maxOutputTokens: 512,
                inputUsdPerMillion: 3,
                outputUsdPerMillion: 15,
              },
            ],
          },
        ],
      },
    );

    const helper = await ran(client, botId);

    expect(helper.status).toBe("complete");
    expect((helperFake.calls[0]?.tools ?? []).map((tool) => tool.name)).toContain("computer");
    const [result] = toolMessages(helperFake.calls.at(-1)!);
    expect(result?.error).toBe(noVisionError);
    expect(screenCommands(computerFake)).toEqual([]);
    // An action that never runs is never reviewed, so it never waits for an Approval.
    expect(reviewer.calls).toEqual([]);
  }, 60_000);
});

describe("Auto-review of the computer tool", () => {
  it("reviews each action that does more than look, and not a screenshot or a wait", async () => {
    const { client, botId, computerFake, reviewer } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [
        round(computerCall({ action: "screenshot" })),
        round(computerCall({ action: "wait", duration: 0 })),
        round(computerCall({ action: { type: "screenshot" } })),
        round(computerCall({ action: "left_click", coordinate: [10, 20] })),
        round(computerCall({ actions: [{ type: "wait" }, { type: "type", text: "hi" }] })),
        round(text("Done.")),
      ],
    );

    const helper = await ran(client, botId);

    expect(helper.status).toBe("complete");
    const rows = await reviewsOf(botId);
    expect(rows.map((row) => row.tool)).toEqual(["computer", "computer"]);
    expect(rows.map((row) => row.input)).toEqual([
      { action: "left_click", coordinate: [10, 20] },
      { actions: [{ type: "wait" }, { type: "type", text: "hi" }] },
    ]);
    for (const row of rows) expect(row).toMatchObject({ helperId: helper.id, turnId: null });
    expect(reviewer.calls).toHaveLength(2);
    expect(screenCommands(computerFake)).toContain("DISPLAY=:1 xdotool mousemove 10 20 click 1");
  }, 60_000);

  it("waits for an Approval on a blocked action, and runs it only once the user allows it", async () => {
    const block: ReviewVerdict = {
      outcome: "block",
      reason: "You didn't ask to delete anything.",
      summary: "Click Delete",
    };
    const { client, botId, computerFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [round(computerCall({ action: "left_click", coordinate: [10, 20] })), round(text("Done."))],
      { reviewer: fakeReviewer(() => verdictRound(block)) },
    );

    await sent(client, botId);
    await expect
      .poll(async () => (await reviewsOf(botId)).find((row) => row.state === "waiting"), {
        timeout: 10_000,
      })
      .toBeTruthy();
    const waiting = (await reviewsOf(botId)).find((row) => row.state === "waiting")!;
    expect(waiting).toMatchObject({ tool: "computer", turnId: null });
    // Nothing reached the Screen while it waits.
    expect(screenCommands(computerFake)).toEqual([]);

    await client.bot.review.allow({ reviewId: waiting.id });
    await expect
      .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
      .toBe("complete");

    expect(screenCommands(computerFake)).toEqual([
      "DISPLAY=:1 xdotool mousemove 10 20 click 1",
      shot,
    ]);
  }, 30_000);
});

/** An OpenAI click that comes with a pending safety check. */
const safetyClick = {
  action: { type: "click", button: "left", x: 30, y: 40 },
  pending_safety_checks: [
    { id: "check-1", code: "malicious_instructions", message: "This page may be unsafe." },
  ],
};
const safetyClickCommand = "DISPLAY=:1 xdotool mousemove 30 40 click 1";

describe("OpenAI safety checks on the computer tool", () => {
  /** The Bot's waiting Approval, once there is one. */
  async function waitingReview(botId: string) {
    await expect
      .poll(async () => (await reviewsOf(botId)).find((row) => row.state === "waiting"), {
        timeout: 10_000,
      })
      .toBeTruthy();
    return (await reviewsOf(botId)).find((row) => row.state === "waiting")!;
  }

  it("always waits for an Approval, with no Auto-review, and runs on yes with the checks acknowledged", async () => {
    const { client, botId, computerFake, reviewer, helperFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [round(computerCall(safetyClick)), round(text("Done."))],
    );

    await sent(client, botId);
    const waiting = await waitingReview(botId);

    expect(waiting).toMatchObject({ tool: "computer", verdict: "block", turnId: null });
    expect(waiting.input).toEqual(safetyClick);
    expect(waiting.deadline).toEqual(expect.any(Date));
    // Nothing reached the Screen while it waits, and no model reviewed it.
    expect(screenCommands(computerFake)).toEqual([]);
    expect(reviewer.calls).toEqual([]);

    await client.bot.review.allow({ reviewId: waiting.id });
    await expect
      .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
      .toBe("complete");

    expect(screenCommands(computerFake)).toEqual([safetyClickCommand, shot]);
    expect(reviewer.calls).toEqual([]);
    expect(toolMessages(helperFake.calls.at(-1)!).at(-1)?.error).toBeUndefined();
    expect(await reviewsOf(botId)).toHaveLength(1);
  }, 30_000);

  it("refuses on no, with an error the Helper sees", async () => {
    const { client, botId, computerFake, helperFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [round(computerCall(safetyClick)), round(text("Stopped."))],
    );

    await sent(client, botId);
    const waiting = await waitingReview(botId);
    await client.bot.review.deny({ reviewId: waiting.id });
    await expect
      .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
      .toBe("complete");

    expect(toolMessages(helperFake.calls.at(-1)!).at(-1)?.error).toContain("The user denied it.");
    expect(screenCommands(computerFake)).toEqual([]);
  }, 30_000);

  it("refuses on silence: no answer in 15 seconds is no", async () => {
    let skewMs = 0;
    const { client, botId, computerFake, helperFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [round(computerCall(safetyClick)), round(text("Stopped."))],
      { clock: () => new Date(Date.now() + skewMs) },
    );

    await sent(client, botId);
    await waitingReview(botId);
    skewMs += 15_000;
    await expect
      .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
      .toBe("complete");

    expect(toolMessages(helperFake.calls.at(-1)!).at(-1)?.error).toContain(
      "didn't approve it within 15 seconds",
    );
    expect(screenCommands(computerFake)).toEqual([]);
    expect((await reviewsOf(botId)).map((row) => row.state)).toEqual(["expired"]);
  }, 30_000);

  it("doesn't ask again on a replay", async () => {
    let releaseType: (() => void) | undefined;
    const { client, botId, deps, computerFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [
        round(computerCall(safetyClick)),
        round(computerCall({ action: "type", text: "hi" })),
        round(text("Never comes.")),
      ],
      {
        reviewer: fakeReviewer(() => verdictRound(passVerdict)),
        // The second action hangs on the Screen until the test lets it go.
        onCommand: async ({ command }) => {
          if (command.includes("xdotool type")) {
            await new Promise<void>((resolve) => (releaseType = resolve));
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    await sent(client, botId);
    await client.bot.review.allow({ reviewId: (await waitingReview(botId)).id });
    await expect.poll(() => releaseType !== undefined, { timeout: 10_000 }).toBe(true);
    const [running] = await helpersOf(botId);
    const commandsBefore = screenCommands(computerFake);
    expect(commandsBefore).toEqual([
      safetyClickCommand,
      shot,
      "DISPLAY=:1 xdotool type --delay 12 -- 'hi'",
    ]);
    const reviewsBefore = await reviewsOf(botId);

    await botHelperJob.onFailed!({ helperId: running!.id }, new Error("lost"), { deps });

    // The click is read as recorded: it neither runs nor waits for an Approval again.
    expect(screenCommands(computerFake)).toEqual(commandsBefore);
    expect(await reviewsOf(botId)).toEqual(reviewsBefore);
    releaseType?.();
  }, 30_000);

  it("replays a recorded safety-check call past the time limit, instead of ending the Helper", async () => {
    let releaseType: (() => void) | undefined;
    let skewMs = 0;
    const { client, botId, deps, computerFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [
        round(computerCall(safetyClick)),
        round(computerCall({ action: "type", text: "hi" })),
        round(text("Never comes.")),
      ],
      {
        clock: () => new Date(Date.now() + skewMs),
        reviewer: fakeReviewer(() => verdictRound(passVerdict)),
        // The second action hangs on the Screen until the test lets it go.
        onCommand: async ({ command }) => {
          if (command.includes("xdotool type")) {
            await new Promise<void>((resolve) => (releaseType = resolve));
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    await sent(client, botId);
    await client.bot.review.allow({ reviewId: (await waitingReview(botId)).id });
    await expect.poll(() => releaseType !== undefined, { timeout: 10_000 }).toBe(true);
    const commandsBefore = screenCommands(computerFake);
    expect(commandsBefore).toHaveLength(3);

    // The attempt is lost, and the next one starts past the Helper's time limit.
    skewMs = helperTimeLimitMs + 120_000;
    await reapStaleJobs(getTestDb(), new Date(Date.now() + skewMs), silent, deps.parts.jobs);
    await expect
      .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
      .toBe("error");
    releaseType?.();

    // The click was read as recorded, so the loop got as far as the next live call, which the
    // limit ended. Ended at the click, the recorded history no longer fit the code: a crash.
    const [helper] = await helpersOf(botId);
    expect(helper).toMatchObject({ status: "error", report: helperEndings.timedOut });
    expect(screenCommands(computerFake)).toEqual(commandsBefore);
  }, 30_000);
});

describe("a Stop during a computer action", () => {
  it("still releases the key it held down", async () => {
    let clicking = false;
    const { client, botId, computerFake } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [
        round(computerCall({ action: "left_click", coordinate: [10, 20], text: "ctrl" })),
        round(text("Never comes.")),
      ],
      {
        // The click hangs on the Screen until its command is killed.
        onCommand: async ({ command, signal }) => {
          if (command.includes("click")) {
            clicking = true;
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    await sent(client, botId);
    await expect.poll(() => clicking, { timeout: 10_000 }).toBe(true);
    const [running] = await helpersOf(botId);
    await client.bot.helper.stop({ botId, helperId: running!.id });
    await expect
      .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
      .not.toBe("running");

    await expect
      .poll(() => screenCommands(computerFake), { timeout: 10_000 })
      .toEqual([
        "DISPLAY=:1 xdotool keydown -- 'ctrl'",
        "DISPLAY=:1 xdotool mousemove 10 20 click 1",
        "DISPLAY=:1 xdotool keyup -- 'ctrl'",
      ]);
  }, 30_000);
});

describe("a replay of the computer tool", () => {
  it("never runs a recorded action again", async () => {
    let releaseType: (() => void) | undefined;
    const { client, botId, deps, computerFake, reviewer } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [
        round(computerCall({ action: "left_click", coordinate: [10, 20] })),
        round(computerCall({ action: "type", text: "hi" })),
        round(text("Never comes.")),
      ],
      {
        reviewer: fakeReviewer(() => verdictRound(passVerdict)),
        // The second action hangs on the Screen until the test lets it go.
        onCommand: async ({ command }) => {
          if (command.includes("xdotool type")) {
            await new Promise<void>((resolve) => (releaseType = resolve));
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    await sent(client, botId);
    await expect.poll(() => releaseType !== undefined, { timeout: 10_000 }).toBe(true);
    const [running] = await helpersOf(botId);
    const commandsBefore = screenCommands(computerFake);
    expect(commandsBefore).toEqual([
      "DISPLAY=:1 xdotool mousemove 10 20 click 1",
      shot,
      "DISPLAY=:1 xdotool type --delay 12 -- 'hi'",
    ]);
    const reviewsBefore = reviewer.calls.length;

    // The job's last-chance ending replays its Checkpoints: the click is read as recorded.
    await botHelperJob.onFailed!({ helperId: running!.id }, new Error("lost"), { deps });

    expect(screenCommands(computerFake)).toEqual(commandsBefore);
    expect(reviewer.calls).toHaveLength(reviewsBefore);
    const [helper] = await helpersOf(botId);
    expect(helper?.status).toBe("error");
    const [result] = (helper?.transcript ?? []).filter((entry) => entry.role === "tool");
    expect(JSON.stringify(result?.content)).toContain("screenshot:");
    releaseType?.();
  }, 30_000);

  it("records the action before its screenshot, so a retry only takes the screenshot", async () => {
    let releaseShot: (() => void) | undefined;
    const { client, botId } = await userWith(
      "openai:gpt-6-luna",
      [handsOff, round()],
      [round(computerCall({ action: "left_click", coordinate: [10, 20] })), round(text("Done."))],
      {
        // The screenshot hangs until the test lets it go.
        onShot: () => new Promise<void>((resolve) => (releaseShot = resolve)),
      },
    );

    await sent(client, botId);
    await expect.poll(() => releaseShot !== undefined, { timeout: 10_000 }).toBe(true);
    const [running] = await helpersOf(botId);
    const recorded = () =>
      getTestDb()
        .select({ name: jobEvent.name, result: jobEvent.result })
        .from(jobEvent)
        .where(
          and(
            eq(jobEvent.jobId, running!.jobId!),
            inArray(jobEvent.name, ["computer", "computer:screenshot"]),
          ),
        )
        .orderBy(asc(jobEvent.seq));
    await expect
      .poll(async () => (await recorded()).map((row) => row.name), { timeout: 10_000 })
      .toContain("computer");
    expect(await recorded()).toEqual([{ name: "computer", result: { result: "left_click" } }]);

    releaseShot!();
    await expect
      .poll(async () => (await helpersOf(botId))[0]?.status, { timeout: 10_000 })
      .toBe("complete");
    expect((await recorded()).map((row) => row.name)).toEqual(["computer", "computer:screenshot"]);
  }, 30_000);
});
