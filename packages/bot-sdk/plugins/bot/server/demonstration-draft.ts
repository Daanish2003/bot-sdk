import { chat, type ContentPart, type ModelMessage } from "@tanstack/ai";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { deleteBlobsBestEffort } from "../../../core/server/blob/store";
import { bot, botDemonstration, botDemonstrationEvent } from "../../../core/server/db/schema";
import type { BotSdkContext } from "../../../core/server/plugin";
import type { ComputerHandle } from "../../computer/server/plugin";
import { parseModelId } from "../../models/shared/models";
import { promptCharactersOf, reportedUsageOf } from "../../models/server/run-usage";
import { defineJob } from "../../runner/server/jobs/define";
import { nameLimit, problemOf, skillsDirectory } from "../../skills/server/skills";
import { computerOf } from "./computer-tools";
import {
  demonstrationDraftJobName,
  demonstrationRetentionJobName,
  rewriteCard,
} from "./demonstration";
import { lockConversation, receive } from "./router";
import { hintChanged } from "./turn";

/*
 * The drafting pass (spec #713, ticket #720): once a Demonstration is Done, one call on the Bot's
 * model, with no tools and outside the Bot's context, turns its goal, inputs, steps and
 * screenshots into a SKILL.md, saved at once in the Bot's Skills folder. A Trigger from the
 * Demonstration then wakes the Bot with the Skill's name, never its screenshots (slide 32).
 */

/** What opens the drafting prompt, so a test's fake model can tell its call from a Turn's. */
export const demonstrationDraftMarker = "You turn a recorded demonstration into a Skill";

/** The most screenshots one drafting call is shown, spread evenly over the steps. */
const screenshotLimit = 40;

/** The most screenshot bytes one drafting call carries, well under a Provider's request limit. */
const screenshotBytesLimit = 16 * 1024 * 1024;

/**
 * Adapted from workflow-use's workflow builder prompt (browser-use/workflow-use,
 * `workflows/workflow_use/builder/prompts.py`): the user's goal comes first, what changes each run
 * becomes a named input, and steps that pick from content that changes are left to judgement. It
 * writes prose for a Computer-use Helper instead of a replayable JSON workflow.
 */
const draftPrompt = [
  `${demonstrationDraftMarker}: written instructions that let a Computer-use agent do the same task again on its own, in a browser, next time.`,
  "You get the user's goal, the inputs they said change each time, every step they took (its kind, page URL, the element's label and a CSS selector, and what they typed or chose), and screenshots of some steps. A password the user typed shows as ••••••••: never guess it, and never write any secret into the Skill. Where the user paused, they did something private you were not shown.",
  "Reply with the SKILL.md only, no code fence and nothing before or after it:",
  "---\nname: <a short name for the task: lowercase a-z, 0-9 and -, at most 40 characters>\ndescription: Use this when <the task, in one line, at most 200 characters>\n---",
  "## Inputs: each value that changes from run to run, one per line, with what it means and the value used this time as an example. Include the inputs the user named, and any other value they typed that would change next time.",
  "## Steps: numbered, in plain prose an agent can follow: which site or page to open, what to click or type, and why. Write an input by its name, not this run's value. Give a recorded selector only as a hint in brackets, since pages change; describe the element by its label first. Where the user picked from content that changes (a date, a row in a list), say how to choose, not what was chosen. Leave out accidental or repeated steps.",
  "## How to check: how to tell the task worked, such as what the last page should show.",
].join("\n\n");

/** A Demonstration as the drafting pass reads it. */
type Drafted = {
  id: string;
  botId: string;
  userId: string;
  conversationId: string;
  model: string;
  goal: string;
  inputs: string[];
  state: string;
};

async function draftedFacts(
  deps: BotSdkContext,
  demonstrationId: string,
): Promise<Drafted | undefined> {
  const [row] = await deps.db
    .select({
      id: botDemonstration.id,
      botId: botDemonstration.botId,
      userId: botDemonstration.userId,
      conversationId: botDemonstration.conversationId,
      model: bot.model,
      goal: botDemonstration.goal,
      inputs: botDemonstration.inputs,
      state: botDemonstration.state,
    })
    .from(botDemonstration)
    .innerJoin(bot, eq(bot.id, botDemonstration.botId))
    .where(eq(botDemonstration.id, demonstrationId));
  return row;
}

/**
 * The drafting call's input: the goal and inputs, then each step as a line, each screenshot shown
 * (up to `screenshotLimit`, spread evenly, and `screenshotBytesLimit` in all) right after its
 * step's line, when the model reads `images`. A pause mark reads as the gap it was; a screenshot
 * whose bytes are gone is left out.
 */
async function draftInput(
  deps: BotSdkContext,
  demonstration: Drafted,
  images: boolean,
): Promise<ContentPart[]> {
  const events = await deps.db
    .select()
    .from(botDemonstrationEvent)
    .where(eq(botDemonstrationEvent.demonstrationId, demonstration.id))
    .orderBy(asc(botDemonstrationEvent.sequence));
  const shot = images ? events.filter((event) => event.screenshotKey !== null) : [];
  const every = Math.max(1, shot.length / screenshotLimit);
  const picked = Array.from(
    { length: Math.min(shot.length, screenshotLimit) },
    (_, index) => shot[Math.floor(index * every)]!,
  );
  const bytesOf = new Map(
    await Promise.all(
      picked.map(
        async (event) => [event.id, await deps.blobStore.get(event.screenshotKey!)] as const,
      ),
    ),
  );
  let budget = screenshotBytesLimit;
  const inputs = demonstration.inputs.length > 0 ? demonstration.inputs.join("; ") : "(none)";
  const parts: ContentPart[] = [
    {
      type: "text",
      content: [
        `Goal: ${demonstration.goal}`,
        `Inputs the user said change each time: ${inputs}`,
        "Steps:",
      ].join("\n"),
    },
  ];
  let step = 0;
  for (const event of events) {
    if (event.kind === "pause") {
      parts.push({ type: "text", content: "(The user paused here; nothing was recorded.)" });
      continue;
    }
    step += 1;
    const fields = [
      `${step}. ${event.kind}`,
      event.label && `label ${JSON.stringify(event.label)}`,
      event.value !== null && `value ${JSON.stringify(event.value)}`,
      event.selector && `selector ${event.selector}`,
      event.url && `on ${event.url}`,
    ].filter(Boolean);
    parts.push({ type: "text", content: fields.join(", ") });
    const bytes = bytesOf.get(event.id);
    if (!bytes || bytes.byteLength > budget) continue;
    budget -= bytes.byteLength;
    parts.push({
      type: "image",
      source: { type: "data", value: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
    });
  }
  if (step === 0) parts.push({ type: "text", content: "(no steps were recorded)" });
  return parts;
}

/**
 * The drafting call, checked against the Quota first and recorded as `skill_draft`: the model's
 * reply, or why there is none.
 */
async function draftSkill(
  deps: BotSdkContext,
  demonstration: Drafted,
): Promise<{ reply: string } | { error: string }> {
  const models = deps.plugin("models");
  const call = await models.resolveModelCall(demonstration.userId, demonstration.model);
  if (!call) return { error: "the Bot's model can't be called" };
  if (!(await call.meter.mayRun()).ok) return { error: "the user's Quota is spent" };
  // A model that can't read images drafts from the steps alone.
  const images = (await models.resolveModel(demonstration.userId, demonstration.model))?.images;
  const messages: ModelMessage[] = [
    { role: "user", content: await draftInput(deps, demonstration, images ?? false) },
  ];
  try {
    const result = await chat({
      adapter: models.adapterForCall(demonstration.model, call),
      systemPrompts: [draftPrompt],
      messages,
      stream: false,
    });
    const provider = parseModelId(demonstration.model)?.provider ?? "";
    const reported = reportedUsageOf(provider, result.chunks);
    await call.meter.record({
      kind: "skill_draft",
      usage: models.messageUsage(reported.usage, {
        promptCharacters: promptCharactersOf(messages),
        parts: [{ type: "text", text: result.text }],
      }),
      reportedCost: reported.cost,
      sourceId: demonstration.id,
    });
    return { reply: result.text };
  } catch (error) {
    deps.logger.error(`Drafting a Skill from Demonstration ${demonstration.id} failed`, error);
    return { error: "the model call failed" };
  }
}

/** A frontmatter's `name:` line. */
const nameLine = /^name:.*$/m;

/**
 * The reply's SKILL.md, code fences stripped and its `name` made a valid one, with that name; or
 * why it isn't a usable Skill, checked as the Skills block checks one.
 */
function draftedSkill(
  reply: string,
  goal: string,
): { skill: string; name: string } | { error: string } {
  const text = reply
    .replaceAll("\r\n", "\n")
    .trim()
    .replace(/^```[a-z]*\n/i, "")
    .replace(/\n```$/, "")
    .trim();
  const name = baseName(text, goal);
  const skill = text.replace(nameLine, `name: ${name}`);
  const problem = problemOf(name, skill);
  return problem ? { error: `the draft isn't a usable Skill (${problem})` } : { skill, name };
}

/** A Skill name from the one the model chose, or from the goal when that one has nothing usable. */
function baseName(skill: string, goal: string): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "");
  const chosen = /^name:\s*["']?(.*?)["']?\s*$/m.exec(skill)?.[1] ?? "";
  return slug(chosen) || slug(goal) || "demonstrated-task";
}

/**
 * Saves `skill` in Bot `botId`'s Skills folder under a free name: the one it chose, then `-2`,
 * `-3`… on a clash, with its frontmatter's `name` set to match. A folder that already holds this
 * very text (a retried save) is taken as its own. Never overwrites a Skill. Returns the name.
 */
async function saveDraft(
  computer: ComputerHandle,
  { botId, skill, base }: { botId: string; skill: string; base: string },
): Promise<string> {
  const directory = skillsDirectory(botId);
  const taken = new Set(
    ((await computer.list(directory)) ?? [])
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.name),
  );
  for (let count = 1; ; count += 1) {
    const suffix = count === 1 ? "" : `-${count}`;
    const name = `${base.slice(0, nameLimit - suffix.length)}${suffix}`;
    const content = skill.replace(nameLine, `name: ${name}`);
    const path = `${directory}/${name}/SKILL.md`;
    if (taken.has(name)) {
      const bytes = await computer.readFile(path);
      if (bytes && new TextDecoder().decode(bytes) === content) return name;
      continue;
    }
    await computer.writeFile(path, content);
    return name;
  }
}

/**
 * Ends a `drafting` Demonstration as `outcome` says, under its Conversation's row lock: `saved`
 * with its Skill, or `failed`; its card closes, and a Trigger from it (`demonstration:<id>`) wakes
 * the Bot. One no longer `drafting` stays as it is, so a retry sends one Trigger. The Trigger is a
 * `helper` / `helper` one, like a Helper's report: it carries the SDK's notice, not the user's words,
 * and the Show me card, not a divider, shows it in the thread.
 */
async function finish(
  deps: BotSdkContext,
  demonstration: Drafted,
  outcome: { name: string } | { error: string },
) {
  const saved = "name" in outcome;
  const ended = await deps.db.transaction(async (tx) => {
    await lockConversation(tx, demonstration.conversationId);
    const rows = await tx
      .update(botDemonstration)
      .set(saved ? { state: "saved", skillName: outcome.name } : { state: "failed" })
      .where(and(eq(botDemonstration.id, demonstration.id), eq(botDemonstration.state, "drafting")))
      .returning({ id: botDemonstration.id });
    if (rows.length === 0) return false;
    await rewriteCard(tx, demonstration.conversationId, demonstration.id, (card) => ({
      ...card,
      state: saved ? "saved" : "failed",
    }));
    const heading = `Demonstration finished: ${demonstration.goal}`;
    await receive(deps, tx, {
      id: demonstrationTriggerId(demonstration.id),
      conversationId: demonstration.conversationId,
      source: "helper",
      channel: "helper",
      text: saved
        ? `${heading}\n\nThe Skill drafted from it is saved as ${outcome.name}, at ` +
          `${skillsDirectory(demonstration.botId)}/${outcome.name}/SKILL.md. Read it, sum it up ` +
          "for the user in a few lines, and ask what to change."
        : `${heading}\n\nCouldn't write the Skill: ${outcome.error}. Tell the user, and offer to ` +
          "write it from what they describe instead.",
      receivedAt: deps.clock(),
    });
    return true;
  });
  if (!ended) return;
  deps.plugin("runner").wake();
  await hintChanged(deps, demonstration.conversationId);
}

/** The id of the Trigger a Demonstration's drafting pass wakes the Bot with. */
export const demonstrationTriggerId = (demonstrationId: string) =>
  `demonstration:${demonstrationId}`;

/**
 * The drafting pass, queued when a Demonstration goes to `drafting`: the call, recorded once, then
 * the save, recorded once, then the ending. A job the runner gives up on ends it `failed`.
 */
export const demonstrationDraftJob = defineJob({
  name: demonstrationDraftJobName,
  payload: z.object({ demonstrationId: z.uuid() }),
  run: async ({ demonstrationId }, { deps, activity }) => {
    const demonstration = await draftedFacts(deps, demonstrationId);
    if (demonstration?.state !== "drafting") return;
    const drafted = await activity("skill_draft", () => draftSkill(deps, demonstration));
    if ("error" in drafted) return finish(deps, demonstration, drafted);
    const skill = draftedSkill(drafted.reply, demonstration.goal);
    if ("error" in skill) return finish(deps, demonstration, skill);
    const name = await activity("skill_save", () =>
      saveDraft(computerOf(deps, demonstration.userId), {
        botId: demonstration.botId,
        skill: skill.skill,
        base: skill.name,
      }),
    );
    await finish(deps, demonstration, { name });
  },
  onFailed: async ({ demonstrationId }, _error, deps) => {
    const demonstration = await draftedFacts(deps, demonstrationId);
    if (demonstration?.state !== "drafting") return;
    await finish(deps, demonstration, { error: "something went wrong while writing it" });
  },
});

/**
 * Deletes a Demonstration's events, then their screenshots' bytes, 7 days after it ended
 * (spec #713). The row stays as a record.
 */
export const demonstrationRetentionJob = defineJob({
  name: demonstrationRetentionJobName,
  payload: z.object({ demonstrationId: z.uuid() }),
  run: async ({ demonstrationId }, { deps }) => {
    const deleted = await deps.db
      .delete(botDemonstrationEvent)
      .where(eq(botDemonstrationEvent.demonstrationId, demonstrationId))
      .returning({ key: botDemonstrationEvent.screenshotKey });
    await deleteBlobsBestEffort(
      deps,
      deleted.flatMap((row) => row.key ?? []),
    );
  },
});
