import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  botDemonstration,
  botDemonstrationEvent,
  botTrigger,
  usage,
} from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import type { HostProvider } from "../../../../plugins/models/server/types";
import { demonstrationEventBlobKey } from "../../../../plugins/bot/server/demonstration-capture";
import { demonstrationDraftMarker } from "../../../../plugins/bot/server/demonstration-draft";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { claimJob } from "../../../../plugins/runner/server/jobs/store";
import { skills } from "../../../../plugins/skills/server/plugin";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "../../../support/deps";
import { createFakeAdapter, round, runError, text, toolCall } from "../../../support/fake-adapter";
import { fakeReviewer } from "../../../support/fake-reviewer";
import { fakeJobClock } from "../../../support/jobs";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";
import { followSend } from "../../../support/follow-send";

const model = "openai:gpt-6-luna";
const hostModel = "anthropic:claude-sonnet-5-5";
const hostProviders: HostProvider[] = [
  {
    provider: "anthropic",
    credentials: { apiKey: "sk-host-secret-never-stored" },
    models: [
      {
        modelId: "claude-sonnet-5-5",
        // Listed without image input, so a drafting call on it sends no screenshot.
        images: false,
        maxOutputTokens: 512,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      },
    ],
  },
];
const silent = { error: () => {} };
const dayMs = 24 * 60 * 60_000;
const start = new Date("2030-03-15T12:00:00.000Z");
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const goal = "Copy this week's payouts into the sheet";
const inputs = ["the week"];

const watchUser = () =>
  toolCall({ name: "run_tool", input: { name: "watch_user", args: { goal, inputs } } });
const ends = () => toolCall({ name: "send_to_user", input: { text: "Go ahead.", endTurn: true } });

type Chunks = ReturnType<typeof round>;

const isDraft = (options: TextOptions) =>
  JSON.stringify(options.systemPrompts ?? []).includes(demonstrationDraftMarker);

const skillText = (name: string) =>
  [
    "---",
    `name: ${name}`,
    "description: Use this when the user wants this week's payouts copied into the sheet",
    "---",
    "## Inputs",
    "- the week",
    "## Steps",
    "1. Open the payouts dashboard.",
    "## How to check",
    "The sheet has a row per payout.",
  ].join("\n");

/**
 * A Bot "Ada" whose first Turn started a Demonstration, which it returns, with three captured
 * steps (one with a screenshot) and a pause mark. The Bot's Turns play `turns` in order, then
 * quiet rounds; the drafting calls play `drafts`.
 */
async function demonstrating({
  drafts = [],
  turns = [],
  host = false,
  getQuota,
}: {
  drafts?: Chunks[];
  turns?: Chunks[];
  host?: boolean;
} & Pick<TestDepsOverrides, "getQuota"> = {}) {
  const timer = fakeJobClock(start);
  const turnRounds = [round(watchUser(), ends()), ...turns];
  const reviewer = fakeReviewer();
  const fake = createFakeAdapter({
    rounds: Array.from(
      { length: 40 },
      () => (options: TextOptions) =>
        isDraft(options) ? (drafts.shift() ?? round()) : (turnRounds.shift() ?? round()),
    ),
  });
  const computerFake = fakeComputerProvider({
    onCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: timer.clock,
    deps: () => deps!,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    features: [skills()],
    memory: false,
    jobs,
    adapterFor: () => fake.adapter,
    reviewAdapterFor: () => reviewer.adapter,
    clock: timer.clock.now,
    ...(host && { hostProviders }),
    getQuota,
  });
  started.push(jobs);
  const user = await insertUser();
  if (!host) {
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
  }
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model: host ? hostModel : model });
  const runDue = async () => {
    for (;;) {
      const claimed = await claimJob(getTestDb(), timer.clock.now(), { respectRunAfter: true });
      if (!claimed) return;
      await jobs.runClaimed(claimed);
    }
  };
  const stream = await followSend(client, { botId, id: uuidv7(), text: "let me show you" });
  await stream.next();
  await stream.return(undefined);
  timer.advance(500);
  await runDue();
  const [row] = await getTestDb()
    .select()
    .from(botDemonstration)
    .where(eq(botDemonstration.botId, botId));
  const demonstrationId = row!.id;
  const shot = uuidv7();
  const screenshotKey = demonstrationEventBlobKey(demonstrationId, shot);
  await deps.blobStore.put(screenshotKey, png, { contentType: "image/png" });
  await getTestDb()
    .insert(botDemonstrationEvent)
    .values([
      {
        id: uuidv7(),
        demonstrationId,
        sequence: 1,
        offsetMs: 1_000,
        kind: "navigation",
        url: "https://pay.example.com/payouts",
        label: "Payouts",
      },
      {
        id: shot,
        demonstrationId,
        sequence: 2,
        offsetMs: 2_000,
        kind: "click",
        url: "https://pay.example.com/payouts",
        label: "Export week",
        selector: "#export",
        screenshotKey,
      },
      { id: uuidv7(), demonstrationId, sequence: 3, offsetMs: 3_000, kind: "pause" },
      {
        id: uuidv7(),
        demonstrationId,
        sequence: 4,
        offsetMs: 4_000,
        kind: "input",
        url: "https://sheets.example.com/login",
        label: "Password",
        selector: "#password",
        value: "••••••••",
      },
    ]);
  /** Ends the Demonstration as Done and runs what that queues: the drafting pass and its Turn. */
  const done = async () => {
    await client.bot.demonstration.done({ demonstrationId });
    await runDue();
    // The Turn the Trigger starts runs a moment later, as one a Message starts does.
    timer.advance(500);
    await runDue();
  };
  return {
    fake,
    reviews: reviewer.calls,
    computerFake,
    deps,
    client,
    user,
    botId,
    demonstrationId,
    screenshotKey,
    timer,
    runDue,
    done,
  };
}

const skillPath = (botId: string, name: string) =>
  `/home/user/bots/${botId}/skills/${name}/SKILL.md`;

const fileText = (files: Map<string, Uint8Array>, path: string) => {
  const bytes = files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
};

const rowOf = async (demonstrationId: string) =>
  (
    await getTestDb()
      .select()
      .from(botDemonstration)
      .where(eq(botDemonstration.id, demonstrationId))
  )[0];

const triggerOf = async (demonstrationId: string) =>
  (
    await getTestDb()
      .select()
      .from(botTrigger)
      .where(eq(botTrigger.id, `demonstration:${demonstrationId}`))
  )[0];

const cardOf = async (client: ReturnType<typeof chatRpc>, botId: string) => {
  for (const { control } of (await client.bot.get({ botId })).messages)
    if (control?.kind === "demonstration") return control;
  return undefined;
};

const textOf = (messages: readonly ModelMessage[]) =>
  messages
    .map((entry) =>
      typeof entry.content === "string"
        ? entry.content
        : (entry.content ?? [])
            .map((part) => (part.type === "text" ? part.content : `[${part.type}]`))
            .join("\n"),
    )
    .join("\n");

const hasImage = (call: TextOptions) =>
  ((call.messages ?? []) as ModelMessage[]).some(
    (entry) => Array.isArray(entry.content) && entry.content.some((part) => part.type === "image"),
  );

describe("the drafting pass", { timeout: 30_000 }, () => {
  it("makes one call with no tools on the Bot's model, given the goal, inputs, steps and screenshots", async () => {
    const { fake, done, botId } = await demonstrating({
      drafts: [round(text(skillText("copy-payouts")))],
    });

    await done();

    const drafts = fake.calls.filter(isDraft);
    expect(drafts).toHaveLength(1);
    const [call] = drafts;
    expect(call!.threadId).toBe(botId);
    expect(call!.tools ?? []).toEqual([]);
    const input = textOf((call!.messages ?? []) as ModelMessage[]);
    expect(input).toContain(goal);
    expect(input).toContain("the week");
    expect(input).toContain("Export week");
    expect(input).toContain("#export");
    expect(input).toContain("https://pay.example.com/payouts");
    expect(input).toContain("paused");
    expect(input).toContain("••••••••");
    // The screenshot of step 2 goes in, as an image.
    const images = ((call!.messages ?? []) as ModelMessage[]).flatMap((entry) =>
      Array.isArray(entry.content) ? entry.content.filter((part) => part.type === "image") : [],
    );
    expect(images).toEqual([
      {
        type: "image",
        source: { type: "data", value: Buffer.from(png).toString("base64"), mimeType: "image/png" },
      },
    ]);
  });

  it("writes the SKILL.md, sets saved, closes the card, meters skill_draft and shows the chip", async () => {
    // On Host credentials, so the call is recorded (one on the user's own key never is).
    const { fake, done, computerFake, client, botId, demonstrationId, user } = await demonstrating({
      host: true,
      drafts: [round(text("```markdown\n", skillText("copy-payouts"), "\n```"))],
    });

    await done();

    expect(fileText(computerFake.files, skillPath(botId, "copy-payouts"))).toBe(
      skillText("copy-payouts"),
    );
    expect(await rowOf(demonstrationId)).toMatchObject({
      state: "saved",
      skillName: "copy-payouts",
    });
    expect(await cardOf(client, botId)).toMatchObject({ state: "saved" });
    const rows = await getTestDb()
      .select()
      .from(usage)
      .where(and(eq(usage.userId, user.id), eq(usage.kind, "skill_draft")));
    expect(rows).toEqual([
      expect.objectContaining({ model: hostModel, sourceId: demonstrationId }),
    ]);
    // The Turn the Trigger woke shows the Skill chip.
    const { turns } = await client.bot.get({ botId });
    expect(turns.at(-1)?.skillChanges).toEqual([{ kind: "saved", name: "copy-payouts" }]);
    expect(turns[0]?.skillChanges).toBeNull();
    expect(fake.calls.filter(isDraft)).toHaveLength(1);
  });

  it("wakes the Bot with a Trigger naming the Skill, and no screenshot reaches its context", async () => {
    const { fake, done, botId, demonstrationId } = await demonstrating({
      drafts: [round(text(skillText("copy-payouts")))],
    });

    await done();

    const trigger = await triggerOf(demonstrationId);
    expect(trigger?.turnId).not.toBeNull();
    const woken = fake.calls.filter((call) => !isDraft(call)).at(-1)!;
    const input = textOf((woken.messages ?? []) as ModelMessage[]);
    expect(input).toContain(skillPath(botId, "copy-payouts"));
    expect(input).toMatch(/read it.*sum it up.*ask what to change/is);
    for (const call of fake.calls.filter((entry) => !isDraft(entry))) {
      expect(hasImage(call)).toBe(false);
    }
  });

  it("picks -2, then -3, on a name clash and never overwrites a Skill", async () => {
    const { done, computerFake, botId, demonstrationId } = await demonstrating({
      drafts: [round(text(skillText("copy-payouts")))],
    });
    const encode = (value: string) => new TextEncoder().encode(value);
    computerFake.files.set(skillPath(botId, "copy-payouts"), encode("mine"));
    computerFake.files.set(skillPath(botId, "copy-payouts-2"), encode("mine too"));

    await done();

    expect(fileText(computerFake.files, skillPath(botId, "copy-payouts"))).toBe("mine");
    expect(fileText(computerFake.files, skillPath(botId, "copy-payouts-2"))).toBe("mine too");
    expect(fileText(computerFake.files, skillPath(botId, "copy-payouts-3"))).toBe(
      skillText("copy-payouts-3"),
    );
    expect(await rowOf(demonstrationId)).toMatchObject({
      state: "saved",
      skillName: "copy-payouts-3",
    });
  });

  it("sets failed, closes the card and wakes the Bot saying so when the call fails", async () => {
    const { fake, done, computerFake, client, botId, demonstrationId } = await demonstrating({
      drafts: [round(runError("The provider is down"))],
    });

    await done();

    expect(await rowOf(demonstrationId)).toMatchObject({ state: "failed", skillName: null });
    expect(await cardOf(client, botId)).toMatchObject({ state: "failed" });
    expect([...computerFake.files.keys()].filter((path) => path.includes("/skills/"))).toEqual([]);
    const trigger = await triggerOf(demonstrationId);
    expect(trigger?.text).toMatch(/couldn't write the Skill/i);
    expect(trigger?.turnId).not.toBeNull();
    const woken = fake.calls.filter((call) => !isDraft(call)).at(-1)!;
    expect(textOf((woken.messages ?? []) as ModelMessage[])).toMatch(/couldn't write the Skill/i);
  });

  it("sets failed without a call while the user's Quota is spent", async () => {
    let quota: Awaited<ReturnType<NonNullable<TestDepsOverrides["getQuota"]>>> = null;
    const { fake, done, user, demonstrationId } = await demonstrating({
      host: true,
      getQuota: async () => quota,
      drafts: [round(text(skillText("copy-payouts")))],
    });
    quota = { budgetUsd: 0.0002, window: "month" };
    await getTestDb().insert(usage).values({
      id: uuidv7(),
      userId: user.id,
      kind: "turn",
      model: hostModel,
      inputTokens: 100,
      outputTokens: 0,
      costMicros: 1_000_000,
      estimated: false,
      createdAt: start,
    });

    await done();

    expect(fake.calls.filter(isDraft)).toEqual([]);
    expect(await rowOf(demonstrationId)).toMatchObject({ state: "failed" });
    expect((await triggerOf(demonstrationId))?.text).toMatch(/Quota/);
    expect(
      await getTestDb()
        .select()
        .from(usage)
        .where(and(eq(usage.userId, user.id), eq(usage.kind, "skill_draft"))),
    ).toEqual([]);
  });

  it("sends no screenshot to a model that can't read images", async () => {
    const { fake, done, demonstrationId } = await demonstrating({
      host: true,
      drafts: [round(text(skillText("copy-payouts")))],
    });

    await done();

    const [call] = fake.calls.filter(isDraft);
    expect(hasImage(call!)).toBe(false);
    expect(textOf((call!.messages ?? []) as ModelMessage[])).toContain("Export week");
    expect(await rowOf(demonstrationId)).toMatchObject({ state: "saved" });
  });

  it("sets failed, writing nothing, when the draft isn't a usable Skill", async () => {
    const broken = skillText("copy-payouts").replace(
      "description: Use this when",
      "description: Copies",
    );
    const { done, computerFake, demonstrationId } = await demonstrating({
      drafts: [round(text(broken))],
    });

    await done();

    expect(await rowOf(demonstrationId)).toMatchObject({ state: "failed", skillName: null });
    expect([...computerFake.files.keys()].filter((path) => path.includes("/skills/"))).toEqual([]);
    expect((await triggerOf(demonstrationId))?.text).toContain(
      'description must start with "Use this when"',
    );
  });

  it("shows the drafted Skill once on its chip when the woken Turn edits it too", async () => {
    const { done, client, botId } = await demonstrating({
      drafts: [round(text(skillText("copy-payouts")))],
      turns: [
        round(
          toolCall({
            name: "write",
            input: {
              path: "skills/copy-payouts/SKILL.md",
              content: skillText("copy-payouts").replace("1. Open", "1. Sign in, then open"),
            },
          }),
        ),
        round(),
      ],
    });

    await done();

    const { turns } = await client.bot.get({ botId });
    expect(turns.at(-1)?.skillChanges).toEqual([{ kind: "saved", name: "copy-payouts" }]);
  });
});

describe("Auto-review", { timeout: 30_000 }, () => {
  it("shows the Trigger as the SDK's notice, never as the user's words", async () => {
    const { done, reviews } = await demonstrating({
      drafts: [round(text(skillText("copy-payouts")))],
      turns: [round(toolCall({ name: "shell", input: { command: "ls" } })), round()],
    });

    await done();

    expect(reviews).toHaveLength(1);
    const sent = textOf((reviews[0]!.messages ?? []) as ModelMessage[]);
    expect(sent).toContain("a Skill was drafted from what the user showed the Bot");
    expect(sent).not.toContain("A Message from the user.");
    expect(sent).not.toContain("A Helper's report");
  });
});

describe("retention", { timeout: 30_000 }, () => {
  const eventsOf = (demonstrationId: string) =>
    getTestDb()
      .select()
      .from(botDemonstrationEvent)
      .where(eq(botDemonstrationEvent.demonstrationId, demonstrationId))
      .orderBy(asc(botDemonstrationEvent.sequence));

  it("deletes a Demonstration's events and screenshots 7 days after it ends; the row stays", async () => {
    const { done, deps, demonstrationId, screenshotKey, timer, runDue } = await demonstrating({
      drafts: [round(text(skillText("copy-payouts")))],
    });
    await done();

    timer.advance(7 * dayMs - 10_000);
    await runDue();
    expect(await eventsOf(demonstrationId)).toHaveLength(4);
    expect(await deps.blobStore.get(screenshotKey)).not.toBeNull();

    timer.advance(10_000);
    await runDue();

    expect(await eventsOf(demonstrationId)).toEqual([]);
    expect(await deps.blobStore.get(screenshotKey)).toBeNull();
    expect(await rowOf(demonstrationId)).toMatchObject({ state: "saved" });
  });

  it("also after Cancel", async () => {
    const { client, deps, demonstrationId, screenshotKey, timer, runDue } = await demonstrating();
    await client.bot.demonstration.cancel({ demonstrationId });

    timer.advance(7 * dayMs);
    await runDue();

    expect(await eventsOf(demonstrationId)).toEqual([]);
    expect(await deps.blobStore.get(screenshotKey)).toBeNull();
    expect(await rowOf(demonstrationId)).toMatchObject({ state: "cancelled" });
  });
});
