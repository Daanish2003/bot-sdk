import { type ModelMessage, type TextOptions, toolDefinition } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { botTurn } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import { deleteUserData, exportUserData } from "../../../core/server/user-data";
import { saveCredentials } from "../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../plugins/runner/server/jobs/in-process";
import { fakeComputerProvider } from "../../plugins/computer/server/fake-provider";
import { createTestSdk, type TestDeps } from "../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../support/fake-adapter";
import { followSend } from "../../support/follow-send";
import type { FeatureEntry } from "../../../core/server/create-chat";
import { defineFeature } from "../../../core/server/index";
import { createPinsTable, dropPinsTable, pin, pins } from "../../support/pins-feature";
import { chatRpc } from "../../support/sdk";
import { getTestDb } from "../../support/test-database";
import { insertUser } from "../../support/users";

/*
 * A feature written only against the public `defineFeature` (spec #871), enabled on a test
 * instance and driven through a Bot's Turns from outside: its tool, its Prompt start section and
 * Change notes, its `afterTurn`, its job and its part of a user's delete and export.
 */

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];

beforeAll(() => createPinsTable(getTestDb()));
// The table is the test's alone: other files in this worker check every `user_id` table.
afterAll(() => dropPinsTable(getTestDb()));
afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with an OpenAI key and a Bot with its Computer and the `pins` feature, whose Model plays `rounds`. */
async function botWithPins(rounds: Round[], features: FeatureEntry[] = [pins()]) {
  const fake = createFakeAdapter({ rounds });
  const computerFake = fakeComputerProvider();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: systemClock,
    deps: () => deps!,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    features,
    // No memory pass: every model call the fake plays is a Turn's.
    memory: false,
    jobs,
    adapterFor: () => fake.adapter,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model });
  return { fake, client, botId, user, deps };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text })) {
    // Read to the end of the Turn.
  }
}

const pinNote = (text: string) =>
  toolCall({ name: "run_tool", input: { name: "pin_note", args: { text } } });

const textOf = (content: ModelMessage["content"] | undefined) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => (part.type === "text" ? part.content : "")).join("");

/** The system blocks a model call sent, as text. */
const systemOf = (call: TextOptions | undefined) =>
  (call?.systemPrompts ?? []).map((prompt) =>
    typeof prompt === "string" ? prompt : prompt.content,
  );

/** The newest message a model call sent: the Turn's input, with its Change notes. */
const newestOf = (call: TextOptions | undefined) =>
  textOf(
    ((call?.messages ?? []) as ModelMessage[]).findLast((entry) => entry.role === "user")?.content,
  );

const rowsOf = async (userId: string, kind: string) =>
  (await getTestDb().select().from(pin).where(eq(pin.userId, userId)))
    .filter((row) => row.kind === kind)
    .map((row) => row.text);

describe("a feature built with defineFeature", { timeout: 30_000 }, () => {
  it("offers its tool in a Turn, and the scripted Model calls it", async () => {
    const { fake, client, botId, user } = await botWithPins([round(pinNote("buy milk")), round()]);

    await send(client, botId, "remember to buy milk");

    const messagesOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];
    // Deferred, like every tool that isn't the core's: listed by name in the first message.
    expect(textOf(messagesOf(fake.calls[0])[0]?.content)).toContain("pin_note");
    expect(textOf(messagesOf(fake.calls[1]).at(-1)?.content)).toContain('"pinned":true');
    expect(await rowsOf(user.id, "pin")).toEqual(["buy milk"]);
  });

  it("puts its section in the Prompt start, and tells what changed since in a Change note once", async () => {
    const { fake, client, botId } = await botWithPins([
      round(pinNote("buy milk")),
      round(),
      round(),
      round(),
    ]);

    await send(client, botId, "remember to buy milk");
    await send(client, botId, "anything new?");
    await send(client, botId, "and now?");

    // Built by the first Turn, before the pin: the section stays as it was.
    expect(systemOf(fake.calls[0])).toContain("[Pinned notes]");
    expect(systemOf(fake.calls[2])).toContain("[Pinned notes]");
    expect(newestOf(fake.calls[2])).toContain("Pin added: buy milk");
    expect(newestOf(fake.calls[3])).not.toContain("Pin added");
  });

  it("tells a removal, and the same change again once it happens again", async () => {
    const { fake, client, botId, user } = await botWithPins([
      round(pinNote("buy milk")),
      round(),
      round(),
      round(),
      round(),
    ]);
    await send(client, botId, "remember to buy milk");
    const pinsOfUser = and(eq(pin.userId, user.id), eq(pin.kind, "pin"));
    const pinned = await getTestDb().select().from(pin).where(pinsOfUser);
    await send(client, botId, "anything new?");
    await getTestDb().delete(pin).where(pinsOfUser);
    await send(client, botId, "and now?");
    await getTestDb().insert(pin).values(pinned);
    await send(client, botId, "and again?");

    expect(newestOf(fake.calls[2])).toContain("Pin added: buy milk");
    expect(newestOf(fake.calls[3])).toContain("Pin removed: buy milk");
    expect(newestOf(fake.calls[4])).toContain("Pin added: buy milk");
  });

  it("ends the Turn when its afterTurn throws, undoing only the feature's writes", async () => {
    const failing = defineFeature({
      id: "failing",
      afterTurn: async (tx, turn) => {
        await tx.insert(pin).values({
          id: `failing-${turn.id}`,
          userId: turn.userId,
          botId: turn.botId,
          kind: "failing",
          text: "written",
        });
        throw new Error("afterTurn failed");
      },
    });
    const { client, botId, user } = await botWithPins([round(), round()], [pins(), failing]);

    await send(client, botId, "hello");
    await send(client, botId, "hello again");

    expect(await rowsOf(user.id, "turn_end")).toEqual(["complete", "complete"]);
    expect(await rowsOf(user.id, "failing")).toEqual([]);
  });

  it("runs its afterTurn in the Turn's end transaction, and the job it queues runs", async () => {
    const { client, botId, user } = await botWithPins([round(pinNote("buy milk")), round()]);

    await send(client, botId, "remember to buy milk");

    // Inside the end's transaction, the Turn's row already holds its ended status.
    expect(await rowsOf(user.id, "turn_end")).toEqual(["complete"]);
    await expect.poll(() => rowsOf(user.id, "digest"), { timeout: 10_000 }).toEqual(["buy milk"]);
  });

  it("gives its tools asynchronously, a line of the first message's environment, and the earlier Turns' tool calls", async () => {
    const lens = defineFeature({
      id: "lens",
      tools: async () => [
        toolDefinition({
          name: "lens_tool",
          description: "Looks.",
          inputSchema: z.object({}),
        }).server(async () => ({ looked: true })),
      ],
      prompt: async (turn) => ({
        section: "[Lens]",
        environment: "Lens: on.",
        changeNotes: [
          `Lens saw: ${turn.earlier
            .flatMap((earlier) => earlier.transcript)
            .flatMap((entry) => entry.toolCalls ?? [])
            .map((call) => `${call.function.name}(${call.function.arguments})`)
            .join(", ")}`,
        ],
      }),
    });
    const { fake, client, botId } = await botWithPins(
      [round(pinNote("buy milk")), round(), round()],
      [pins(), lens],
    );

    await send(client, botId, "remember to buy milk");
    await send(client, botId, "anything new?");

    const first = textOf(((fake.calls[0]?.messages ?? []) as ModelMessage[])[0]?.content);
    expect(first).toContain("Lens: on.");
    expect(first).toContain("lens_tool");
    expect(newestOf(fake.calls[2])).toContain("Lens saw: ");
    expect(newestOf(fake.calls[2])).toContain("buy milk");
  });

  it("gets the Turn's start, and its Change notes come in the order the features are listed", async () => {
    const starts: Date[] = [];
    const named = (id: string, onPrompt?: (startedAt: Date) => void) =>
      defineFeature({
        id,
        prompt: async (turn) => {
          onPrompt?.(turn.startedAt);
          return { section: `[${id}]`, changeNotes: [`note from ${id}`] };
        },
      });
    const { fake, client, botId } = await botWithPins(
      [round(), round()],
      [named("zeta", (startedAt) => starts.push(startedAt)), named("alpha")],
    );

    await send(client, botId, "hi");
    await send(client, botId, "again");

    const [turn] = await getTestDb()
      .select({ startedAt: botTurn.startedAt })
      .from(botTurn)
      .where(eq(botTurn.botId, botId))
      .orderBy(botTurn.startedAt)
      .limit(1);
    expect(starts[0]).toEqual(turn!.startedAt);
    const newest = newestOf(fake.calls[1]);
    expect(newest.indexOf("note from zeta")).toBeGreaterThanOrEqual(0);
    expect(newest.indexOf("note from zeta")).toBeLessThan(newest.indexOf("note from alpha"));
  });

  it("counts only the Turns that started before the Turn it builds as seen", async () => {
    const counts: number[] = [];
    const watcher = defineFeature({
      id: "watcher",
      prompt: async (turn) => {
        counts.push(turn.earlier.length);
        return { section: "[Watcher]" };
      },
    });
    const { client, botId } = await botWithPins([round(), round()], [watcher]);
    await send(client, botId, "hi");
    // A Turn of the same Prompt start that started after the next one: not yet seen by it.
    const [first] = await getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
    await getTestDb()
      .insert(botTurn)
      .values({ ...first!, id: uuidv7(), startedAt: new Date(Date.now() + 3_600_000) });

    await send(client, botId, "again");

    expect(counts).toEqual([0, 1]);
  });

  it("takes part in the user's export and delete", async () => {
    const { client, botId, user, deps } = await botWithPins([round(pinNote("buy milk")), round()]);
    await send(client, botId, "remember to buy milk");
    await expect.poll(() => rowsOf(user.id, "digest"), { timeout: 10_000 }).toHaveLength(1);

    const exported = await exportUserData(deps, user.id);
    await deleteUserData(deps, user.id);

    expect(exported.pins).toEqual({
      pins: ["digest: buy milk", "pin: buy milk", "turn_end: complete"],
    });
    expect(await getTestDb().select().from(pin).where(eq(pin.userId, user.id))).toEqual([]);
  });
});
