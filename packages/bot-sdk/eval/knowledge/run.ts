import { sendAndFollow } from "../../test/support/follow-send";
// The Knowledge eval (spec #737, ticket #744): real Turns on a real Model, through the real `bot` and
// `knowledge` plugins, on the local E2B Computer seeded with a fixture Knowledge. It scores whether a
// Bot finds and reads what the user kept, cites it, says when it isn't there, saves what it is asked
// to keep, and ignores instructions inside a file. Run it with `pnpm -F @ai-chat/bot-sdk eval:knowledge`;
// see eval/knowledge/README.md.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter and fake Computer,
// which play each case's scripted tool calls, for checking the script without any Model, key or E2B.
// `--limit=<n>` runs the first n cases; `--case=<id>` only that case.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { botTrigger, computer as computerTable } from "../../core/server/db/schema";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { bot } from "../../plugins/bot/server/plugin";
import { computerOf } from "../../plugins/bot/server/computer-tools";
import { sendToUserToolName } from "../../plugins/bot/server/turn";
import { walk } from "../../plugins/knowledge/server/files";
import { knowledge } from "../../plugins/knowledge/server/plugin";
import { knowledgeDirectory } from "../../plugins/knowledge/shared/folder";
import { runnerJobs } from "../../plugins/runner/server/plugin";
import { createFakeAdapter, round, toolCall } from "../../test/support/fake-adapter";
import { isReviewCall, passVerdict, verdictRound } from "../../test/support/fake-reviewer";
import { fakeComputerProvider } from "../../test/plugins/computer/server/fake-provider";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import {
  createComputerSdk,
  databaseUrlFromEnv,
  defaultTemplate,
  localE2bProvider,
  prepareSchema,
} from "../computer/setup";
import { fail, keyFor } from "../turn/judge-model";
import { freshBot, type TurnEnv } from "../turn/case";
import { toolCallsOf } from "../turn/routine-score";
import { waitForTurn } from "../turn/routine-run";
import { sentTexts } from "../turn/score";
import { filesOf, type KnowledgeCase, knowledgeCases } from "./cases";
import { type Expect, type Score, scoreKnowledge, tallyKnowledge } from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Model the Bots use unless told otherwise: the step's default on OpenRouter. */
const defaultModel = "openrouter:anthropic/claude-sonnet-5.5";

/** The adapter, except that an Auto-review call (a risky shell command) gets a pass and no scripted round. */
function passingReviews(adapter: AnyTextAdapter): AnyTextAdapter {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property !== "chatStream") return Reflect.get(target, property, receiver);
      return (options: TextOptions) =>
        isReviewCall(options)
          ? createFakeAdapter({ rounds: [verdictRound(passVerdict)] }).adapter.chatStream(options)
          : target.chatStream(options);
    },
  });
}

type RunResult = {
  caseId: string;
  gating: boolean;
  repeat: number;
  expected: Expect;
  score: Score;
  sent: string[];
  toolCalls: { name: string; args: unknown }[];
  /** The paths in Knowledge after the Turn that were not there before. */
  added: string[];
  ms: number;
  error?: string;
};

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  const only = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
  const repeats = Number(process.env.EVAL_REPEATS ?? 1);
  // The local E2B fits few sandboxes, so a real run goes one Turn at a time unless told otherwise.
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? (fake ? 4 : 1));
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["EVAL_CONCURRENCY", concurrency],
    ["--limit", limit ?? 1],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  if (only && !knowledgeCases.some((evalCase) => evalCase.id === only)) {
    fail(`--case must be one of ${knowledgeCases.map((evalCase) => evalCase.id).join(", ")}`);
  }
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (eval/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  const computerProvider = fake
    ? fakeComputerProvider().provider
    : localE2bProvider(process.env.EVAL_TEMPLATE ?? defaultTemplate);
  /** The fake Model, one adapter per run (found by its API key), playing its rounds across calls. */
  const adapters = new Map<string, ReturnType<typeof createFakeAdapter>["adapter"]>();
  const sdk = createComputerSdk({
    db,
    provider: computerProvider,
    more: [bot(), knowledge()],
    models: (real) =>
      fake
        ? {
            ...real,
            adapterFor: (_model, credentials) => {
              const adapter = adapters.get((credentials as { apiKey: string }).apiKey);
              if (!adapter) throw new Error("No fake script for this run");
              return adapter;
            },
          }
        : { ...real, linkedCredentials: plan?.linkedCredentials },
  });
  const jobs = runnerJobs(sdk);
  await jobs.start();

  const env: TurnEnv = {
    db,
    sdk,
    model,
    credentialsFor: (caseId, repeat) => {
      if (!fake) return apiKey === null ? null : { apiKey };
      const key = `fake-${caseId}-${repeat}-${randomUUID()}`;
      const evalCase = knowledgeCases.find((c) => c.id === caseId)!;
      adapters.set(
        key,
        passingReviews(
          createFakeAdapter({
            rounds: [
              ...evalCase.fake.map((step) =>
                round(toolCall({ name: step.name, input: step.input })),
              ),
              round(
                toolCall({
                  name: sendToUserToolName,
                  input: { text: evalCase.reply, endTurn: true },
                }),
              ),
            ],
          }).adapter,
        ),
      );
      return { apiKey: key };
    },
  };

  /** Kills the user's sandbox and removes the row, as the computer eval does, so the E2B pool frees up. */
  async function dropComputer(userId: string) {
    const [row] = await db.select().from(computerTable).where(eq(computerTable.userId, userId));
    if (row?.sandboxId)
      await computerProvider.kill(row.sandboxId).catch((caught) => {
        console.log(`      could not kill sandbox ${row.sandboxId}: ${caught}`);
      });
    await db.delete(computerTable).where(eq(computerTable.userId, userId));
  }

  async function runCase(evalCase: KnowledgeCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const base = {
      caseId: evalCase.id,
      gating: evalCase.gating,
      repeat,
      expected: evalCase.expect,
    };
    let sent: string[] = [];
    let toolCalls: RunResult["toolCalls"] = [];
    let added: string[] = [];
    // The case's user owns its one Computer, shared by every Bot the case makes.
    let userId: string | undefined;
    try {
      const fresh = await freshBot(env, evalCase.id, repeat);
      userId = fresh.userId;
      const made = fresh.bot;
      const computer = computerOf(sdk, userId);
      const seeded = filesOf(evalCase);
      // A few at a time: a case with filler writes about 150 files.
      const entries = Object.entries(seeded);
      for (let at = 0; at < entries.length; at += 10) {
        await Promise.all(
          entries
            .slice(at, at + 10)
            .map(([path, content]) => computer.writeFile(`${knowledgeDirectory}/${path}`, content)),
        );
      }

      const id = uuidv7();
      for await (const _ of await sendAndFollow(sdk, {
        userId,
        botId: made.id,
        id,
        text: evalCase.message,
      })) {
        // Drained: the stream ends when the Turn does.
      }
      const [trigger] = await db
        .select({ turnId: botTrigger.turnId })
        .from(botTrigger)
        .where(eq(botTrigger.id, id));
      if (!trigger?.turnId) throw new Error("No Turn took the user Message");
      const turn = await waitForTurn(env, trigger.turnId, 5 * 60_000);
      toolCalls = toolCallsOf(turn.transcript);
      sent = sentTexts(turn.transcript);

      const after: Record<string, string> = {};
      const { files } = await walk(computer);
      for (const file of files) {
        // New and changed files only: a Bot may append to a seeded file instead of adding one.
        if (file.size > 100_000) continue;
        const bytes = await computer.readFile(`${knowledgeDirectory}/${file.path}`);
        if (!bytes) continue;
        const text = new TextDecoder().decode(bytes);
        if (!Object.hasOwn(seeded, file.path) || seeded[file.path] !== text)
          after[file.path] = text;
      }
      added = Object.keys(after);
      const score = scoreKnowledge(evalCase.expect, {
        status: turn.status,
        calls: toolCalls,
        sent,
        botId: made.id,
        knowledge: after,
        seeded: [],
      });
      return { ...base, score, sent, toolCalls, added, ms: Date.now() - started };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      return {
        ...base,
        score: { passed: false, reasons: [`error: ${error}`] },
        sent,
        toolCalls,
        added,
        ms: Date.now() - started,
        error,
      };
    } finally {
      // A cleanup failure is logged, not thrown: it must not lose the results of the other cases.
      if (userId)
        await dropComputer(userId).catch((caught) =>
          console.log(`      cleanup failed: ${caught}`),
        );
    }
  }

  const chosen = knowledgeCases.filter((evalCase) => !only || evalCase.id === only);
  const cases = limit === undefined ? chosen : chosen.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Knowledge eval${fake ? " (fake adapter, fake Computer)" : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
  );

  const results: RunResult[] = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
    while (next < runs.length) {
      const { evalCase, repeat } = runs[next++]!;
      const result = await runCase(evalCase, repeat);
      results.push(result);
      const label = result.score.passed ? "pass" : result.gating ? "FAIL" : "miss (not gating)";
      console.log(`  [${results.length}/${runs.length}] ${evalCase.id} #${repeat}: ${label}`);
      for (const reason of result.score.reasons) console.log(`      ${reason}`);
    }
  });
  await Promise.all(lanes);

  console.log("");
  for (const evalCase of cases) {
    const own = results.filter((result) => result.caseId === evalCase.id);
    const passed = own.filter((result) => result.score.passed).length;
    console.log(
      `${evalCase.id.padEnd(18)} ${passed}/${own.length} passed${evalCase.gating ? "" : " (not gating)"}`,
    );
  }
  const tally = tallyKnowledge(results);
  console.log(
    `\nGating: ${tally.gating.passed}/${tally.gating.total} passed. ` +
      `Reworded (not gating): ${tally.reworded.passed}/${tally.reworded.total} answered.`,
  );

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `knowledge-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify(
      { startedAt, fake, model, repeats, tally, runs: results },
      (_key, value) => (value instanceof RegExp ? String(value) : value),
      2,
    ),
  );
  console.log(`\nEvery run (tool calls, replies, new files) is in ${file}`);
  await jobs.stop();
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  // An errored run says nothing about the Bot, but it is not a pass either.
  process.exit(results.every((result) => !result.gating || result.score.passed) ? 0 : 1);
}

await main();
