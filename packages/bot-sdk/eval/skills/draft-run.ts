// The drafting-pass eval (spec #713, ticket #721): calls the real drafting pass (`draftSkill`, #720)
// directly, with no Turn, on the checked-in fixture Demonstrations, and scores the Skill it writes.
// Run it with `pnpm -F @ai-chat/bot-sdk eval:skills:draft`; see eval/skills/README.md.
//
// The fixtures were recorded on a local Chromium, not the real Computer (record-fixtures.ts).
// `--fake` (or EVAL_FAKE=1) plays a scripted drafting reply instead of a Model, for checking the script.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { botDemonstration, botDemonstrationEvent } from "../../core/server/db/schema";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { demonstrationEventBlobKey } from "../../plugins/bot/server/demonstration-capture";
import { draftSkill, type Drafted } from "../../plugins/bot/server/demonstration-draft";
import { bot } from "../../plugins/bot/server/plugin";
import { skills } from "../../plugins/skills/server/plugin";
import { createFakeAdapter, round, text } from "../../test/support/fake-adapter";
import { fakeComputerProvider } from "../../test/plugins/computer/server/fake-provider";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { freshBot, type TurnEnv } from "../turn/case";
import { fail, keyFor } from "../turn/judge-model";
import { type DraftScore, scoreDraft } from "./draft-score";
import { draftExpectations, fakeDraft, loadFixture } from "./fixtures";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Model the drafting pass runs on unless told otherwise: the step's default on OpenRouter. */
const defaultModel = "openrouter:anthropic/claude-sonnet-5.5";

type RunResult = {
  fixture: string;
  repeat: number;
  score: DraftScore;
  /** The drafting call's reply, or the error that stood in for it. */
  reply: string;
  ms: number;
};

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const repeats = Number(process.env.EVAL_REPEATS ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1)
    fail("EVAL_REPEATS must be a whole number, 1 or more");
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (eval/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  /** The fake Model's reply for each run, found by the run's own API key. */
  const replies = new Map<string, string>();
  const sdk = createComputerSdk({
    db,
    provider: fakeComputerProvider().provider,
    more: [bot(), skills()],
    models: (real) =>
      fake
        ? {
            ...real,
            adapterFor: (_model, credentials) => {
              const reply = replies.get((credentials as { apiKey: string }).apiKey);
              if (reply === undefined) throw new Error("No fake reply for this run");
              return createFakeAdapter({ rounds: [round(text(reply))] }).adapter;
            },
          }
        : { ...real, linkedCredentials: plan?.linkedCredentials },
  });
  const env: TurnEnv = {
    db,
    sdk,
    model,
    credentialsFor: (caseId, repeat) => {
      if (!fake) return apiKey === null ? null : { apiKey };
      const key = `fake-${caseId}-${repeat}-${randomUUID()}`;
      replies.set(key, fakeDraft(fixtureById.get(caseId)!, draftExpectations[caseId]!));
      return { apiKey: key };
    },
  };

  const ids = Object.keys(draftExpectations);
  const fixtureById = new Map(
    await Promise.all(ids.map(async (id) => [id, await loadFixture(id)] as const)),
  );

  async function run(id: string, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const fixture = fixtureById.get(id)!;
    try {
      const { userId, bot: made, found } = await freshBot(env, id, repeat);
      const demonstrationId = uuidv7();
      const startedAt = new Date();
      await db.insert(botDemonstration).values({
        id: demonstrationId,
        botId: made.id,
        userId,
        conversationId: found!.conversationId,
        goal: fixture.goal,
        inputs: fixture.inputs,
        state: "drafting",
        screen: 1,
        startedAt,
        endedAt: startedAt,
      });
      for (const event of fixture.events) {
        const eventId = uuidv7();
        const bytes = event.screenshot ? fixture.screenshots.get(event.screenshot) : undefined;
        const screenshotKey = bytes ? demonstrationEventBlobKey(demonstrationId, eventId) : null;
        if (bytes && screenshotKey) {
          await sdk.blobStore.put(screenshotKey, bytes, { contentType: "image/png" });
        }
        await db.insert(botDemonstrationEvent).values({
          id: eventId,
          demonstrationId,
          sequence: event.sequence,
          offsetMs: event.offsetMs,
          kind: event.kind as "click",
          url: event.url,
          label: event.label,
          selector: event.selector,
          value: event.value,
          screenshotKey,
        });
      }
      const drafted: Drafted = {
        id: demonstrationId,
        botId: made.id,
        userId,
        conversationId: found!.conversationId,
        model,
        goal: fixture.goal,
        inputs: fixture.inputs,
        state: "drafting",
      };
      const result = await draftSkill(sdk, drafted);
      if ("error" in result) {
        return {
          fixture: id,
          repeat,
          score: { passed: false, reasons: [`no draft: ${result.error}`] },
          reply: result.error,
          ms: Date.now() - started,
        };
      }
      return {
        fixture: id,
        repeat,
        score: scoreDraft(result.reply, fixture.goal, draftExpectations[id]!),
        reply: result.reply,
        ms: Date.now() - started,
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      return {
        fixture: id,
        repeat,
        score: { passed: false, reasons: [`error: ${error}`] },
        reply: error,
        ms: Date.now() - started,
      };
    }
  }

  const startedAt = new Date().toISOString();
  console.log(
    `Drafting-pass eval${fake ? " (fake adapter)" : ""}: ${ids.length} fixtures x ${repeats} repeats, Model ${model}`,
  );
  const results: RunResult[] = [];
  for (const id of ids) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const result = await run(id, repeat);
      results.push(result);
      console.log(`  ${id} #${repeat}: ${result.score.passed ? "pass" : "FAIL"}`);
      for (const reason of result.score.reasons) console.log(`      ${reason}`);
    }
  }
  const passed = results.filter((result) => result.score.passed).length;
  console.log(`\noverall ${passed}/${results.length} passed`);

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `skills-draft-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify({ startedAt, fake, model, repeats, passed, runs: results }, null, 2),
  );
  console.log(`Every drafted Skill is in ${file}`);
  await db.$client.end();
  process.exit(passed === results.length ? 0 : 1);
}

await main();
