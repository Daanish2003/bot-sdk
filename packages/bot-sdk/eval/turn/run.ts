// The week-one Turn eval (spec #463, "Evals for the week-one Turn"): scores whether a real Model,
// under the fixed Bot system prompt, replies through SendToUser when it should, stays quiet when it
// should, and sets `endTurn` on its last Message. Run it with `pnpm -F @ai-chat/bot-sdk eval:turn`;
// see eval/turn/README.md.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter, which plays what
// each case expects, for checking the script without any Model. `--limit=<n>` runs the first n cases.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnyTextAdapter } from "@tanstack/ai";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { postgresBlobStore } from "../../core/server/blob/postgres";
import { createHookEmitter } from "../../core/server/chat/hooks";
import { createDb, type Database } from "../../core/server/db/index";
import { createGuardedFetch } from "../../core/server/lib/guarded-fetch";
import { migrate as migrateChatSchema } from "../../core/server/migrate";
import type { BotSdkContext } from "../../core/server/plugin";
import { resolveRateLimits } from "../../core/server/rate-limits";
import { memoryRuntime } from "../../core/server/runtime";
import { createBotSdkOver } from "../../core/server/over";
import { runnerJobs } from "../../plugins/runner/server/plugin";
import { productionDeps } from "../../plugins/models/server/plugin";
import type { ModelsDeps } from "../../plugins/models/server/types";
import { createFakeAdapter, round, toolCall } from "../../test/support/fake-adapter";
import { type TurnCase, turnCases } from "./cases";
import { runCase, type TurnRunResult } from "./case";
import { queueCases } from "./queue-cases";
import { type RoutineCase, routineCases } from "./routine-cases";
import { nextThursday } from "./routine-score";
import { runRoutineCase, type RoutineRunResult } from "./routine-run";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { fail, judgeCompletion, keyFor } from "./judge-model";
import { type Complete, runQueueCase, type QueueRunResult } from "./queue-run";
import { formatJudge, tallyQueue } from "./queue-score";
import { tally } from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The key the eval's own credentials are encrypted with. Test data only: nothing is kept. */
const evalKeySecret = "eval-turn-key-secret-not-for-production";

/** Makes the database's tables, as the test database does: the auth tables first, then the chat schema. */
async function prepareSchema(url: string): Promise<Database> {
  const db = createDb({ DATABASE_URL: url });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../../db/src/migrations", import.meta.url)),
  });
  await migrateChatSchema(url);
  return db;
}

/** Runs `worker` over `items`, `size` at a time, keeping the order of the results. */
async function mapPool<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** What the fake Model plays for a step-4 case: what a good Bot would do. */
function routineFakeScript(evalCase: RoutineCase) {
  const send = toolCall({ name: "send_to_user", input: { text: "A fake reply.", endTurn: true } });
  const { createRoutine, setCheckIn, sent } = evalCase.expect;
  if (createRoutine) {
    const input = {
      name: "tech-news",
      prompt: "Give me a short summary of the top tech news.",
      schedule: { days: ["mon", "tue", "wed", "thu", "fri"], at: "08:00" },
    };
    return [round(toolCall({ name: "create_routine", input })), round(send)];
  }
  if (setCheckIn) {
    const at = nextThursday(new Date()).toISOString();
    return [
      round(toolCall({ name: "set_check_in", input: { at, note: "Ask about the contract." } })),
      round(send),
    ];
  }
  return sent === "none" ? [round()] : [round(send)];
}

/** What the fake Model plays for a case: what a good Bot would do. */
function fakeScript(evalCase: TurnCase) {
  const send = (message: string, endTurn: boolean) =>
    toolCall({ name: "send_to_user", input: { text: message, endTurn } });
  if (evalCase.expected === "quiet") return [round()];
  if (evalCase.multi) {
    return [round(send("One.", false), send("Two.", false), send("Three.", true))];
  }
  return [round(send("A fake reply.", true))];
}

/** The adapter, except that its call waits until the Turn is stopped, and then plays nothing. */
function heldUntilStopped(adapter: AnyTextAdapter): AnyTextAdapter {
  return {
    ...adapter,
    chatStream: async function* (options) {
      const signal = options.request?.signal;
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield* adapter.chatStream(options);
    },
  };
}

const percent = (rate: number | null) =>
  rate === null ? "   n/a" : `${(rate * 100).toFixed(1).padStart(5)}%`;

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  const repeats = Number(process.env.EVAL_REPEATS ?? 3);
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);

  const model = fake
    ? (process.env.EVAL_BOT_MODEL ?? "openai:gpt-5.4-mini")
    : process.env.EVAL_BOT_MODEL;
  if (!model) fail("EVAL_BOT_MODEL is not set. See packages/bot-sdk/eval/turn/README.md.");
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["EVAL_CONCURRENCY", concurrency],
    ["--limit", limit ?? 1],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  const databaseUrl = process.env.EVAL_DATABASE_URL;
  if (!databaseUrl) fail("EVAL_DATABASE_URL is not set: a scratch Postgres.");

  // `null`: the Model runs on the owner's ChatGPT plan (eval/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan);

  // The judge defaults to the Bot's own Model when that is an OpenAI or Anthropic one.
  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? model;
  const judgeKey = fake ? "sk-fake" : keyFor(judgeModel, plan, " (the judge)");
  const complete: Complete = fake
    ? async () => "Verdict: yes\nReason: fake judge"
    : judgeCompletion(judgeModel, judgeKey, plan);

  const cases = limit === undefined ? turnCases : turnCases.slice(0, limit);
  const db = await prepareSchema(databaseUrl);
  const logger: Pick<Console, "error"> = console;
  const events = createHookEmitter(undefined, logger);
  const fetch = createGuardedFetch({ schemes: "http-and-https" });
  const keyring = [evalKeySecret];
  const realModels = productionDeps(
    { db, keyring, events, logger, fetch } as unknown as BotSdkContext,
    { linkedCredentials: plan?.linkedCredentials },
  );
  /** The fake Model's case for each run, found by the run's own API key. */
  const scripts = new Map<string, { id: string; rounds: () => ReturnType<typeof round>[] }>();
  /** What the fake Model plays for a queue case: a reply that ends the Turn. */
  const queueScript: TurnCase = { id: "queue", expected: "reply", history: [], message: "" };
  /** How many Turns have asked the fake Model for an adapter, per run. */
  const turnsStarted = new Map<string, number>();
  const modelsDeps: ModelsDeps = fake
    ? {
        ...realModels,
        adapterFor: (_model, credentials) => {
          const evalCase = scripts.get((credentials as { apiKey: string }).apiKey);
          if (!evalCase) throw new Error("No fake script for this run");
          const { adapter } = createFakeAdapter({ rounds: evalCase.rounds() });
          // The interrupting case: the first Turn's Model call holds until the correction stops the
          // Turn, so the fake cannot finish it before the correction is sent. Real runs are not held.
          const key = (credentials as { apiKey: string }).apiKey;
          const turnNumber = (turnsStarted.get(key) ?? 0) + 1;
          turnsStarted.set(key, turnNumber);
          return evalCase.id === "interrupting" && turnNumber === 1
            ? heldUntilStopped(adapter)
            : adapter;
        },
      }
    : realModels;
  const { sdk } = createBotSdkOver(
    {
      context: {
        db,
        blobStore: postgresBlobStore(db),
        runtime: memoryRuntime(),
        logger,
        events,
        fetch,
        keyring,
        rateLimits: resolveRateLimits(),
      },
      models: modelsDeps,
    },
    { basePath: "/api/chat", getUser: () => null, logger: { error: () => {} } },
  );

  // A Turn runs as a job, on the default in-process runner.
  const jobs = runnerJobs(sdk);
  await jobs.start();

  const env = {
    db,
    sdk,
    model,
    credentialsFor: (caseId: string, repeat: number) => {
      if (!fake) return apiKey === null ? null : { apiKey };
      const key = `fake-${caseId}-${repeat}`;
      const turnCase = cases.find((c) => c.id === caseId);
      const routineCase = routineCases.find((c) => c.id === caseId);
      scripts.set(key, {
        id: caseId,
        rounds: () =>
          routineCase
            ? routineFakeScript(routineCase)
            : fakeScript(turnCase ?? { ...queueScript, id: caseId }),
      });
      return { apiKey: key };
    },
  };

  const startedAt = new Date().toISOString();
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  console.log(
    `Turn eval${fake ? " (fake adapter)" : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
  );
  let done = 0;
  const results: TurnRunResult[] = await mapPool(
    runs,
    concurrency,
    async ({ evalCase, repeat }) => {
      const result = await runCase(env, evalCase, repeat);
      done += 1;
      console.log(
        `  [${done}/${runs.length}] ${result.caseId} #${repeat}: ${result.score.passed ? "pass" : "FAIL"}`,
      );
      for (const reason of result.score.reasons) console.log(`      ${reason}`);
      return result;
    },
  );

  console.log(`
Queue evals: ${queueCases.length} cases x ${repeats} repeats, judge ${judgeModel}`);
  const queueRuns = queueCases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const queueResults: QueueRunResult[] = await mapPool(
    queueRuns,
    concurrency,
    async ({ evalCase, repeat }) => {
      const result = await runQueueCase(env, complete, evalCase, repeat);
      console.log(
        `  ${result.caseId} #${repeat}: structural ${result.structural.passed ? "pass" : "FAIL"}, judge ${result.judge ? (result.judge.correct ? "yes" : "NO") : "n/a"}`,
      );
      for (const reason of result.structural.reasons) console.log(`      ${reason}`);
      if (result.judge) console.log(`      judge: ${result.judge.reason}`);
      return result;
    },
  );

  console.log(`
Routine and Check-in evals: ${routineCases.length} cases x ${repeats} repeats, judge ${judgeModel}`);
  const routineRuns = routineCases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const routineResults: RoutineRunResult[] = await mapPool(
    routineRuns,
    concurrency,
    async ({ evalCase, repeat }) => {
      const result = await runRoutineCase(env, complete, evalCase, repeat);
      console.log(
        `  ${result.caseId} #${repeat}: structural ${result.structural.passed ? "pass" : "FAIL"}, judge ${result.judge ? (result.judge.correct ? "yes" : "NO") : "n/a"}`,
      );
      for (const reason of result.structural.reasons) console.log(`      ${reason}`);
      if (result.judge) console.log(`      judge: ${result.judge.reason}`);
      return result;
    },
  );

  await jobs.stop();

  const queueRates = tallyQueue(
    queueResults.map((r) => ({
      caseId: r.caseId,
      structural: r.structural.passed,
      judge: r.judge?.correct ?? null,
    })),
  );

  const routineRates = tallyQueue(
    routineResults.map((r) => ({
      caseId: r.caseId,
      structural: r.structural.passed,
      judge: r.judge?.correct ?? null,
    })),
  );

  const rates = tally(results.map((result) => result.score));
  console.log("");
  for (const [name, row] of Object.entries(rates)) {
    console.log(
      `${name.padEnd(8)} ${String(row.passed).padStart(3)}/${String(row.total).padEnd(3)} ${percent(row.rate)}`,
    );
  }

  for (const [name, row] of Object.entries(queueRates)) {
    console.log(`${name.padEnd(12)} structural ${row.structural}/${row.runs}, ${formatJudge(row)}`);
  }

  for (const [name, row] of Object.entries(routineRates)) {
    console.log(`${name.padEnd(26)} structural ${row.structural}/${row.runs}, ${formatJudge(row)}`);
  }

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `turn-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        startedAt,
        fake,
        model,
        judgeModel,
        repeats,
        rates,
        runs: results,
        queueRates,
        queueRuns: queueResults,
        routineRates,
        routineRuns: routineResults,
      },
      null,
      2,
    ),
  );
  console.log(`\nEvery run is in ${file}`);
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  // A run that errored (a bad key, a rate limit) is not a Model failure: exit non-zero so it is seen.
  process.exit(
    [...results, ...queueResults, ...routineResults].some((result) => result.error) ? 1 : 0,
  );
}

await main();
