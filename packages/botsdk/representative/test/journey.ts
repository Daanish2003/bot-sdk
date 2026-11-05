import type { TextOptions } from "@tanstack/ai";
import { expect } from "vitest";

import type { chatRpc } from "@ai-chat/test-support/sdk";
import { autoSource } from "@ai-chat/test-support/test-customer";
import { round, toolCall } from "@botsdk/testing/fake-adapter";
import { handOffMessage } from "../src/server/replies";

/*
 * The Representatives map's journey (ticket #1335), written once so web chat can walk it again through
 * its routes (#1341): the Channel is a `Visitor`, and everything else is the owner's RPCs and the
 * fake Models' rounds. `walkJourney` holds the assertions; a Channel supplies the world.
 */

export const journeyModel = "openai:gpt-6-luna";
export const journeyBotModel = "openai:gpt-5.4-mini";
export const price = {
  key: "price.haircut",
  type: "money",
  topic: "general",
  value: "45 USD",
} as const;
export const address = "12 Mill Lane";
export const releaseOne = "Release one: answer questions.";
export const releaseTwo = "Release two: answer questions.";

type Rpc = ReturnType<typeof chatRpc>;

/** The Customer's side of a Channel: what they write, and what has reached them, oldest first. */
export type Visitor = {
  says: (text: string) => Promise<void>;
  heard: () => Promise<string[]>;
};

export type JourneyWorld = {
  rpc: Rpc;
  representativeId: string;
  /** The Representative's Model calls so far. */
  modelCalls: () => TextOptions[];
  /** The Bot's Model calls so far. */
  botCalls: () => number;
  visitor: Visitor;
  /** Moves the test's clock past a batch window and lets due jobs run; called while polling. */
  tick: () => Promise<void>;
  /** Assignments handed to the Bot, by status. */
  assignmentStatuses: () => Promise<string[]>;
};

const poll = { timeout: 15_000 };
const quiet = () => round();
const replies = (input: object) =>
  round(toolCall({ name: "reply", input: { topic: "general", ...input } }));
const factReply = (text: string, kind = "answer") =>
  replies({ text, kind, sources: [{ type: "fact", key: price.key }] });

const assignmentIdIn = (call: TextOptions) =>
  /Assignment ([0-9a-f]{8}-[0-9a-f-]{27})/.exec(JSON.stringify(call.messages.slice(1)))![1]!;

/** The Bot's rounds: it finishes the Assignment it was given, with something for the Customer. */
export const botRounds = [
  (call: TextOptions) =>
    round(
      toolCall({
        name: "run_tool",
        input: {
          name: "finish_assignment",
          args: {
            id: assignmentIdIn(call),
            status: "done",
            outcome: "Refunded.",
            for_customer: "Your refund of 20 is on its way.",
          },
        },
      }),
    ),
  quiet,
];

/** The Representative's rounds, in the order the journey calls it; `remembered` adds the memory step. */
export function journeyRounds({ remembered }: { remembered: boolean }) {
  const releaseOf = (call: TextOptions) =>
    /Release (one|two)/.exec(JSON.stringify(call.systemPrompts))![1];
  const echoesRelease = (call: TextOptions) =>
    factReply(`Per release ${releaseOf(call)}, a haircut is {{${price.key}}}.`);
  return [
    factReply("A haircut is {{price.haircut}}."),
    quiet(),
    ...(remembered
      ? [
          replies({
            text: `You live at ${address}.`,
            kind: "answer",
            sources: [{ type: "memory", quote: address }],
          }),
          quiet(),
        ]
      : []),
    round(
      toolCall({
        name: "hand_to_bot",
        input: { title: "A refund", instructions: "They want a refund." },
      }),
    ),
    quiet(),
    (call: TextOptions) =>
      replies({
        text: "Good news: your refund is on its way.",
        kind: "answer",
        sources: [
          {
            type: "assignment",
            assignmentId: /Assignment ([0-9a-f-]{36}): cite/.exec(
              JSON.stringify(call.messages),
            )![1],
            quote: "refund of 20",
          },
        ],
      }),
    quiet(),
    // After Hand back, the message that waited through the takeover.
    replies({ text: "Back with you.", kind: "small_talk", sources: [autoSource] }),
    quiet(),
    echoesRelease,
    quiet(),
    echoesRelease,
    quiet(),
  ];
}

/** Approves the Reply drafts the owner has waiting, once there are some: a reply on memory or a Bot's result is always one. */
async function approveWhenDrafted({ rpc, tick }: JourneyWorld) {
  await expect
    .poll(async () => {
      await tick();
      return (await rpc.representative.replyDraftList()).length;
    }, poll)
    .toBeGreaterThan(0);
  const drafts = await rpc.representative.replyDraftList();
  // Only a reply on memory or a Bot's result is a draft: a fact's answer never waited.
  expect(drafts).toHaveLength(1);
  for (const { id } of drafts) await rpc.representative.replyDraftApprove({ id });
}

/** Waits until `text` has reached the Customer. */
async function hears(world: JourneyWorld, text: string) {
  await expect
    .poll(async () => {
      await world.tick();
      return (await world.visitor.heard()).includes(text);
    }, poll)
    .toBe(true);
}

/**
 * Walks the journey from an owner who has approved Release one and switched the Representative on,
 * with `price` as a Published fact, to a rollback. The Representative's Model answers
 * `journeyRounds`, and the Bot's `botRounds`.
 */
export async function walkJourney(world: JourneyWorld, { remembered }: { remembered: boolean }) {
  const { rpc, representativeId: id, visitor } = world;
  const calls = () => world.modelCalls().length;

  // An answer from a fact: the Customer reads the fact's value, never its key.
  await visitor.says("How much is a haircut?");
  await hears(world, "A haircut is 45 USD.");
  const [summary] = await rpc.representative.threadList({ id });
  const { customer } = await rpc.representative.threadGet({ id: summary!.id });

  // The owner records something about the Customer; only a verified Customer is remembered by it.
  await rpc.representative.customerProfileSet({
    id: customer.id,
    field: "address",
    value: address,
  });
  if (remembered) {
    // An answer from memory: the owner's record reaches the Turn, and the reply quotes it.
    await visitor.says("What do you have on me?");
    await approveWhenDrafted(world);
    await hears(world, `You live at ${address}.`);
    expect(JSON.stringify(world.modelCalls().map((call) => call.messages))).toContain(address);
  }

  // An Assignment: handed to the Bot, finished, and relayed through the gate once the owner approves.
  await visitor.says("I want a refund");
  await hears(world, handOffMessage);
  await approveWhenDrafted(world);
  await hears(world, "Good news: your refund is on its way.");
  expect(await world.assignmentStatuses()).toEqual(["done"]);
  expect(world.botCalls()).toBe(2);

  // Takeover: the Customer's message waits, and no Model call runs; the owner's words reach them.
  await rpc.representative.threadTakeOver({ id: summary!.id });
  const before = calls();
  await visitor.says("Anyone there?");
  await expect
    .poll(async () => {
      await world.tick();
      return (await rpc.representative.threadGet({ id: summary!.id })).messages.some(
        ({ text }) => text === "Anyone there?",
      );
    }, poll)
    .toBe(true);
  for (let tries = 0; tries < 5; tries += 1) await world.tick();
  expect(calls()).toBe(before);
  await rpc.representative.threadSend({ id: summary!.id, text: "The owner is here." });
  await hears(world, "The owner is here.");
  expect(calls()).toBe(before);

  // Hand back: the owner answered the waiting message, so the next one starts a Turn again.
  await rpc.representative.threadHandBack({ id: summary!.id });
  await visitor.says("Thanks, one more thing.");
  await hears(world, "Back with you.");

  // Release two answers, and after rollback Release one answers again.
  await rpc.representative.updateDraft({ id, draft: { jobText: releaseTwo } });
  const two = await rpc.representative.approve({ id });
  await visitor.says("And now?");
  await hears(world, "Per release two, a haircut is 45 USD.");

  const { releases } = await rpc.representative.get({ id });
  expect(releases.map(({ id: releaseId }) => releaseId)).toContain(two.id);
  await rpc.representative.rollback({
    id,
    releaseId: releases.find(({ number }) => number === 1)!.id,
  });
  await visitor.says("And again?");
  await hears(world, "Per release one, a haircut is 45 USD.");

  // An unverified visitor is no one's remembered Customer: no prompt, across the whole journey, held the record.
  if (!remembered) {
    expect(JSON.stringify(world.modelCalls().map((call) => call.messages))).not.toContain(address);
  }
}
