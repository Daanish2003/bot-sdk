import type { AnyTextAdapter, ModelMessage, TextOptions } from "@tanstack/ai";
import { and, asc, eq, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { blob, botHelper, jobEvent } from "../../../../core/server/db/schema";
import { deleteUserData } from "../../../../core/server/user-data";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import {
  keptScreenshots,
  noVisionError,
  removedScreenshot,
} from "../../../../plugins/bot/server/desktop-tools";
import { computerUseHelperPrompt } from "../../../../plugins/bot/server/helper";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { fakeReviewer } from "../../../support/fake-reviewer";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";
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

/** A user whose Bot runs on `model`, over `computer` with a fake provider that photographs `shot`. */
async function userWith(model: string, turns: Round[], helpers: Round[], shot = png) {
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
    onCommand: ({ command }) => {
      const path = command.match(/scrot -o (\S+)$/)?.[1];
      if (path) computerFake.files.set(path, shot);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const reviewer = fakeReviewer();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    deps: () => deps!,
  });
  deps = createTestSdk({
    plugins: [bot(), computer({ provider: computerFake.provider })],
    jobs,
    adapterFor: () => adapter,
    reviewAdapterFor: () => reviewer.adapter,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  const provider = model.split(":")[0]!;
  await saveCredentials(deps, user.id, {
    service: provider as "openai",
    fields: { apiKey: `${provider}-test-key` },
    hint: "…-key",
    verified: true,
  });
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

const desktop = (input: object) => toolCall({ name: "desktop", input });

async function ran(client: ReturnType<typeof chatRpc>, botId: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text: "go" }));
  await expect
    .poll(
      async () => {
        const rows = await getTestDb().select().from(botHelper).where(eq(botHelper.botId, botId));
        return rows.every((row) => row.status !== "running");
      },
      { timeout: 20_000 },
    )
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

describe("a Computer-use Helper's desktop", () => {
  it("runs xdotool on its Screen's display and returns a screenshot as an image part", async () => {
    const { client, botId, helperFake, computerFake } = await userWith(
      "openai:gpt-5.6",
      [handsOff, round()],
      [
        round(desktop({ action: "left_click", coordinate: [10, 20] })),
        round(desktop({ action: "right_click", coordinate: [30, 40] })),
        round(desktop({ action: "double_click", coordinate: [50, 60] })),
        round(desktop({ action: "mouse_move", coordinate: [70, 80] })),
        round(desktop({ action: "left_click_drag", startCoordinate: [1, 2], coordinate: [3, 4] })),
        round(desktop({ action: "type", text: "it's" })),
        round(desktop({ action: "key", text: "ctrl+a" })),
        round(desktop({ action: "scroll", coordinate: [5, 6], scrollDirection: "down" })),
        round(desktop({ action: "wait", seconds: 2 })),
        round(desktop({ action: "screenshot" })),
        round(desktop({ action: "left_click" })),
        round(text("Done.")),
      ],
    );

    const helper = await ran(client, botId);

    expect(helper).toMatchObject({ status: "complete", report: "Done." });
    expect(helperFake.calls[0]?.systemPrompts).toEqual([computerUseHelperPrompt]);
    expect(computerUseHelperPrompt).toContain(
      "Use `desktop` only for what the browser can't reach",
    );
    expect((helperFake.calls[0]?.tools ?? []).map((tool) => tool.name)).toContain("desktop");
    const commands = computerFake
      .callsOf("run")
      .map((call) => call.command)
      .filter((command) => command.includes("xdotool") || command.includes("scrot"));
    const shot = "sleep 0.5 && DISPLAY=:1 scrot -o /tmp/screens/1/desktop.png";
    expect(commands).toEqual([
      "DISPLAY=:1 xdotool mousemove 10 20 click 1",
      shot,
      "DISPLAY=:1 xdotool mousemove 30 40 click 3",
      shot,
      "DISPLAY=:1 xdotool mousemove 50 60 click --repeat 2 --delay 100 1",
      shot,
      "DISPLAY=:1 xdotool mousemove 70 80",
      shot,
      "DISPLAY=:1 xdotool mousemove 1 2 mousedown 1 mousemove 3 4 mouseup 1",
      shot,
      "DISPLAY=:1 xdotool type --delay 12 -- 'it'\\''s'",
      shot,
      "DISPLAY=:1 xdotool key -- 'ctrl+a'",
      shot,
      "DISPLAY=:1 xdotool mousemove 5 6 click --repeat 5 5",
      shot,
      "sleep 2.5 && DISPLAY=:1 scrot -o /tmp/screens/1/desktop.png",
      shot,
    ]);
    // Each action's result is the PNG as an image part; the call missing its coordinate is an error.
    const last = helperFake.calls.at(-1)!;
    const results = toolMessages(last);
    expect(results).toHaveLength(11);
    const image = imagesIn(results.at(-2)!)[0];
    expect(image).toEqual({
      type: "image",
      source: { type: "data", value: Buffer.from(png).toString("base64"), mimeType: "image/png" },
    });
    expect(String(results.at(-1)?.content)).toContain("left_click needs coordinate");
  }, 60_000);

  it("keeps only the newest 3 screenshots in the next model input", async () => {
    const { client, botId, helperFake } = await userWith(
      "openai:gpt-5.6",
      [handsOff, round()],
      [
        ...Array.from({ length: 5 }, () => round(desktop({ action: "screenshot" }))),
        round(text("Looked.")),
      ],
    );

    await ran(client, botId);

    // The fifth call's input has five tool results before pruning, and the sixth has more.
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
      "openai:gpt-5.6",
      [handsOff, round()],
      [
        ...Array.from({ length: 5 }, () => round(desktop({ action: "screenshot" }))),
        round(text("Looked.")),
      ],
      big,
    );

    const helper = await ran(client, botId);

    expect(helper.status).toBe("complete");
    const base64 = Buffer.from(big).toString("base64");
    expect(base64.length).toBe(300_000);
    // Before: the transcript held all 5 screenshots' base64, about 1.5 MB, and each `desktop`
    // Checkpoint its own 300 KB. Now they hold refs.
    const transcript = JSON.stringify(helper.transcript);
    expect(transcript).not.toContain(base64.slice(0, 100));
    expect(transcript.length).toBeLessThan(5_000);
    const desktopResults = (
      await getTestDb()
        .select({ result: jobEvent.result })
        .from(jobEvent)
        .where(and(eq(jobEvent.jobId, helper.jobId!), eq(jobEvent.name, "desktop")))
    ).map((row) => JSON.stringify(row.result));
    expect(desktopResults).toHaveLength(5);
    for (const result of desktopResults) expect(result.length).toBeLessThan(500);
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
      "groq:llama-3.3-70b-versatile",
      [handsOff, round()],
      [round(desktop({ action: "screenshot" })), round(text("Blind."))],
    );

    const helper = await ran(client, botId);

    expect(helper.status).toBe("complete");
    expect((helperFake.calls[0]?.tools ?? []).map((tool) => tool.name)).toContain("desktop");
    const [result] = toolMessages(helperFake.calls.at(-1)!);
    expect(JSON.parse(String(result?.content))).toEqual({ error: noVisionError });
    expect(computerFake.callsOf("run").some((call) => call.command.includes("scrot"))).toBe(false);
    // An action that never runs is never reviewed, so it never waits for an Approval.
    expect(reviewer.calls).toEqual([]);
  }, 60_000);
});
