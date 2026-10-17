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

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { postgresBlobStore } from "../../core/server/blob/postgres";
import { createHookEmitter } from "../../core/server/chat/hooks";
import { createDb, type Database } from "../../core/server/db/index";
import { createGuardedFetch } from "../../core/server/lib/guarded-fetch";
import { migrate as migrateChatSchema } from "../../core/server/migrate";
import type { BotSdkContext } from "../../core/server/plugin";
import { resolveRateLimits } from "../../core/server/rate-limits";
import { memoryRuntime } from "../../core/server/runtime";
import { createBotSdkOver } from "../../plugins/assistant/server/over";
import { bot } from "../../plugins/bot/server/plugin";
import { runnerJobs } from "../../plugins/runner/server/plugin";
import { productionDeps } from "../../plugins/models/server/plugin";
import type { ModelsDeps } from "../../plugins/models/server/types";
import { createFakeAdapter, round, text, toolCall } from "../../test/support/fake-adapter";
import { type TurnCase, turnCases } from "./cases";
import { runCase, type TurnRunResult } from "./case";
import { tally } from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The key the eval's own credentials are encrypted with. Test data only: nothing is kept. */
const evalKeySecret = "eval-turn-key-secret-not-for-production";

/** The API key environment variable of each Provider the eval may use. */
const keyVariables: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

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

/** What the fake Model plays for a case: what a good Bot would do. */
function fakeScript(evalCase: TurnCase) {
  const send = (message: string, endTurn: boolean) =>
    toolCall({ name: "send_to_user", input: { text: message, endTurn } });
  if (evalCase.expected === "quiet") return [round(text("Nothing worth saying."))];
  if (evalCase.multi) {
    return [round(send("One.", false), send("Two.", false), send("Three.", true))];
  }
  return [round(send("A fake reply.", true))];
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
  const provider = model.split(":")[0]!;
  const databaseUrl = process.env.EVAL_DATABASE_URL;
  if (!databaseUrl) fail("EVAL_DATABASE_URL is not set: a scratch Postgres with pgvector.");

  const apiKey = fake ? "sk-fake" : process.env[keyVariables[provider] ?? ""];
  if (!apiKey) fail(`${keyVariables[provider] ?? `A key for ${provider}`} is not set`);

  const cases = limit === undefined ? turnCases : turnCases.slice(0, limit);
  const db = await prepareSchema(databaseUrl);
  const logger: Pick<Console, "error"> = console;
  const events = createHookEmitter(undefined, logger);
  const fetch = createGuardedFetch({ schemes: "http-and-https" });
  const keyring = [evalKeySecret];
  const realModels = productionDeps(
    { db, keyring, events, logger, fetch } as unknown as BotSdkContext,
    { defaultBackgroundModel: undefined },
  );
  /** The fake Model's case for each run, found by the run's own API key. */
  const scripts = new Map<string, TurnCase>();
  const modelsDeps: ModelsDeps = fake
    ? {
        ...realModels,
        adapterFor: (_model, credentials) => {
          const evalCase = scripts.get((credentials as { apiKey: string }).apiKey);
          if (!evalCase) throw new Error("No fake script for this run");
          return createFakeAdapter({ rounds: fakeScript(evalCase) }).adapter;
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
      assistant: { memory: false },
      plugins: [bot()],
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
      if (!fake) return { apiKey };
      const key = `fake-${caseId}-${repeat}`;
      scripts.set(
        key,
        cases.find((c) => c.id === caseId)!,
      );
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

  await jobs.stop();

  const rates = tally(results.map((result) => result.score));
  console.log("");
  for (const [name, row] of Object.entries(rates)) {
    console.log(
      `${name.padEnd(8)} ${String(row.passed).padStart(3)}/${String(row.total).padEnd(3)} ${percent(row.rate)}`,
    );
  }

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `turn-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify({ startedAt, fake, model, repeats, rates, runs: results }, null, 2),
  );
  console.log(`\nEvery run is in ${file}`);
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  // A run that errored (a bad key, a rate limit) is not a Model failure: exit non-zero so it is seen.
  process.exit(results.some((result) => result.error) ? 1 : 0);
}

await main();
