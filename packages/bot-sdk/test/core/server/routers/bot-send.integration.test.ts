import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { botTurn } from "../../../../core/server/db/schema";
import { bot } from "../../../../plugins/bot/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import { createTestSdk } from "../../../support/deps";
import { createFakeAdapter, round, text, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

const model = "openai:gpt-5.6";
const sendToUser = "send_to_user";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** A user with an OpenAI key, a Bot on `model`, and a client over a Bot-enabled SDK whose Model plays `rounds`. */
async function botWith(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
  const deps = createTestSdk({ plugins: [bot()], adapterFor: () => fake.adapter });
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const created = await client.bot.create({ name: "Ada", model });
  return { fake, deps, client, botId: created.id };
}

/** Sends `text` to the Bot and reads the whole stream. */
async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  const events = [];
  for await (const event of await client.bot.send({ botId, text })) events.push(event);
  return events;
}

/** The stream's events, with each Message cut down to its role and text. */
const shapes = (events: Awaited<ReturnType<typeof send>>) =>
  events.map((event) =>
    event.type === "message"
      ? { type: "message", role: event.message.role, text: event.message.text }
      : event,
  );

const sends = (input: { text: string; endTurn: boolean }) => toolCall({ name: sendToUser, input });

async function turnsOf(botId: string) {
  return getTestDb().select().from(botTurn).where(eq(botTurn.botId, botId));
}

/** The model input of one call: its messages, as the adapter got them. */
const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];

describe("bot.send", () => {
  it("keeps a reply with no tool call private: zero Messages, a complete Turn, its text in the transcript", async () => {
    const { client, botId } = await botWith([round(text("Nothing to add here."))]);

    const events = await send(client, botId, "ok");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "ok" },
      { type: "turnEnded", status: "complete" },
    ]);
    expect((await client.bot.get({ botId })).messages.map((row) => row.role)).toEqual(["user"]);
    const [turn] = await turnsOf(botId);
    expect(turn).toMatchObject({ status: "complete" });
    expect(turn?.endedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(turn?.transcript)).toContain("Nothing to add here.");
  });

  it("appends one Message per SendToUser call, never the Model's plain text", async () => {
    const { client, botId } = await botWith([
      round(text("Thinking privately."), sends({ text: "Hello!", endTurn: true })),
    ]);

    const events = await send(client, botId, "hi");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "hi" },
      { type: "message", role: "assistant", text: "Hello!" },
      { type: "turnEnded", status: "complete" },
    ]);
    const { messages } = await client.bot.get({ botId });
    expect(messages.map((row) => [row.role, row.text])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello!"],
    ]);
    // Each streamed Message is the saved one.
    expect(events.slice(0, 2).map((event) => event.type === "message" && event.message)).toEqual(
      messages,
    );
  });

  it("ends the Turn on endTurn: true with no further model call", async () => {
    // Only one round is scripted: another model call would fail the Turn.
    const { client, botId, fake } = await botWith([round(sends({ text: "Done.", endTurn: true }))]);

    const events = await send(client, botId, "do it");

    expect(events.at(-1)).toEqual({ type: "turnEnded", status: "complete" });
    expect(fake.calls).toHaveLength(1);
  });

  it("streams several sends of one Step in order, each its own Message", async () => {
    const { client, botId } = await botWith([
      round(
        sends({ text: "One", endTurn: false }),
        sends({ text: "Two", endTurn: false }),
        sends({ text: "Three", endTurn: true }),
      ),
    ]);

    const events = await send(client, botId, "count to three");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "count to three" },
      { type: "message", role: "assistant", text: "One" },
      { type: "message", role: "assistant", text: "Two" },
      { type: "message", role: "assistant", text: "Three" },
      { type: "turnEnded", status: "complete" },
    ]);
  });

  it("answers an empty text with an error saying what to do, and appends nothing", async () => {
    const { client, botId, fake } = await botWith([
      round(sends({ text: "  ", endTurn: true })),
      round(text("I'll stay quiet.")),
    ]);

    const events = await send(client, botId, "hm");

    expect(shapes(events)).toEqual([
      { type: "message", role: "user", text: "hm" },
      { type: "turnEnded", status: "complete" },
    ]);
    // The Model read the error and got its next Step.
    const result = inputOf(fake.calls[1]).find((message) => message.role === "tool");
    expect(String(result?.content)).toMatch(/text.*empty|empty.*text/i);
    expect(String(result?.content)).toMatch(/reply without calling a tool/i);
  });

  it("replays earlier Turns' transcripts as the next Turn's input, after the fixed system prompt", async () => {
    const { client, botId, fake } = await botWith([
      round(text("Private note."), sends({ text: "Hello!", endTurn: true })),
      round(text("Quiet now.")),
    ]);

    await send(client, botId, "hi");
    await send(client, botId, "thanks");

    const second = fake.calls[1];
    expect(JSON.stringify(second?.systemPrompts)).toContain("send_to_user");
    const input = inputOf(second);
    expect(input.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(input[0]).toMatchObject({ role: "user", content: "hi" });
    // The Model sees its send as a SendToUser call, never as plain assistant text.
    expect(input[1]?.toolCalls?.map((call) => call.function.name)).toEqual([sendToUser]);
    expect(JSON.parse(input[1]?.toolCalls?.[0]?.function.arguments ?? "{}")).toEqual({
      text: "Hello!",
      endTurn: true,
    });
    expect(input[1]?.content).toBe("Private note.");
    expect(input[3]).toMatchObject({ role: "user", content: "thanks" });
  });

  it("gives another user not-found for a Bot that isn't theirs", async () => {
    const { botId, deps } = await botWith([]);
    const other = chatRpc({ user: await insertUser(), deps });

    await expect(other.bot.send({ botId, text: "hi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
