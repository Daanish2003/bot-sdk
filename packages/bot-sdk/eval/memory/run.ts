// The Memory eval (spec #263, "The eval"): scores Memories and the search tool on 40 LongMemEval
// cases. Run it with `pnpm -F @ai-chat/bot-sdk eval:memory`; see eval/memory/README.md.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat and embedding adapters, for
// checking the script without any Model. It runs two cases unless `--limit=<n>` says otherwise.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chat } from "@tanstack/ai";
import { type AnthropicChatModel, createAnthropicChat } from "@tanstack/ai-anthropic";
import { type OpenAIChatModel, createOpenaiChat } from "@tanstack/ai-openai";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { postgresBlobStore } from "../../core/server/blob/postgres";
import { fakeEmbeddingAdapter } from "../../plugins/models/server/fake-embedding-adapter";
import { createDb, type Database } from "../../core/server/db/index";
import { createBotSdkOver } from "../../plugins/assistant/server/over";
import { createHookEmitter } from "../../core/server/chat/hooks";
import { createGuardedFetch } from "../../core/server/lib/guarded-fetch";
import type { ModelsDeps } from "../../plugins/models/server/types";
import type { BotSdkContext } from "../../core/server/plugin";
import { productionDeps } from "../../plugins/models/server/plugin";
import { migrate as migrateChatSchema } from "../../core/server/migrate";
import { resolveRateLimits } from "../../core/server/rate-limits";
import { memoryRuntime } from "../../core/server/runtime";
import type { JobRunner } from "../../plugins/runner/server/jobs/runner";
import { createFakeAdapter, round, text } from "../../test/support/fake-adapter";
import { type CaseResult, type EvalEnv, runCase } from "./case";
import { categories, selectCases, tally } from "./cases";
import { datasetRevision, loadDataset } from "./dataset";

const here = fileURLToPath(new URL(".", import.meta.url));
const cacheDir = join(here, "cache");
const resultsDir = join(here, "results");

/** The key the eval's own credentials are encrypted with. Test data only: nothing is kept. */
const evalKeySecret = "eval-memory-key-secret-not-for-production";

/** The API key environment variable of each Provider the eval may use. */
const keyVariables: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/**
 * The eval runs each Memory job inline (case.ts), so nothing is queued: a Run's enqueue does nothing,
 * and the question's Run makes no Memories.
 */
const noJobs: JobRunner = {
  enqueue: async () => "",
  cancel: async () => {},
  status: async () => undefined,
  schedule: async () => {},
  start: async () => {},
  stop: async () => {},
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) fail(`${name} is not set. See packages/bot-sdk/eval/memory/README.md.`);
  return value;
}

/** The Provider of a `"provider:model"` id. */
function providerOf(model: string): string {
  return model.split(":")[0]!;
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

/** The judge's completion: LongMemEval's judge, at temperature 0, on OpenAI or Anthropic. */
function judgeCompletion(model: string, keyOf: (provider: string) => string) {
  const provider = providerOf(model);
  const modelId = model.slice(provider.length + 1);
  const apiKey = keyOf(provider);
  let adapter;
  if (provider === "openai") {
    adapter = createOpenaiChat(modelId as OpenAIChatModel, apiKey);
  } else if (provider === "anthropic") {
    adapter = createAnthropicChat(modelId as AnthropicChatModel, apiKey);
  } else {
    fail(`EVAL_JUDGE_MODEL must be an openai or anthropic Model, not "${model}"`);
  }
  return async (prompt: string) => {
    const result = await chat({
      adapter,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      modelOptions: { temperature: 0 },
    });
    return result.text;
  };
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

const percent = (value: number | null) =>
  value === null ? "   n/a" : `${(value * 100).toFixed(1).padStart(5)}%`;

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : fake ? 2 : undefined;
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);

  const models = {
    background: fake
      ? (process.env.EVAL_BACKGROUND_MODEL ?? "openai:gpt-5.4-mini")
      : required("EVAL_BACKGROUND_MODEL"),
    answer: fake
      ? (process.env.EVAL_ANSWER_MODEL ?? "anthropic:claude-sonnet-5-5")
      : required("EVAL_ANSWER_MODEL"),
    judge: process.env.EVAL_JUDGE_MODEL ?? "openai:gpt-4o-mini",
  };
  const databaseUrl = process.env.EVAL_DATABASE_URL;
  if (!databaseUrl) fail("EVAL_DATABASE_URL is not set: a scratch Postgres with pgvector.");

  // Keys come from the environment, never from the repo. In fake mode every Provider gets a placeholder.
  const providers = [
    ...new Set([providerOf(models.background), providerOf(models.answer), "openai"]),
  ];
  const keyOf = (provider: string): string => {
    if (fake) return "sk-fake";
    const variable = keyVariables[provider];
    const value = variable ? process.env[variable] : undefined;
    if (!value) fail(`${variable ?? `a key for ${provider}`} is not set`);
    return value;
  };

  const dataset = await loadDataset(cacheDir);
  const cases = selectCases(dataset);
  const chosen = limit === undefined ? cases : cases.slice(0, limit);

  const db = await prepareSchema(databaseUrl);
  const logger: Pick<Console, "error"> = console;
  const events = createHookEmitter(undefined, logger);
  const fetch = createGuardedFetch({ schemes: "http-and-https" });
  const keyring = [evalKeySecret];
  const realModels = productionDeps(
    { db, keyring, events, logger, fetch } as unknown as BotSdkContext,
    { defaultBackgroundModel: models.background },
  );
  const modelsDeps: ModelsDeps = fake
    ? {
        ...realModels,
        // One reply serves every Background Model call: the extract call reads `facts`, and the
        // decide and forget calls read `memory` and `ids` (their keys are all there, each empty).
        adapterFor: (model) =>
          createFakeAdapter({
            rounds: [
              round(
                text(
                  model === models.answer
                    ? "I don't know."
                    : '{"facts":["The user has a fake fact."],"remember":[],"forget":[],"memory":[],"ids":[]}',
                ),
              ),
            ],
          }).adapter,
        embeddingAdapterFor: () => fakeEmbeddingAdapter(),
      }
    : realModels;
  // An instance over the parts: the jobs `runCase` runs directly reach `models` through its `plugin`.
  const { sdk: base } = createBotSdkOver(
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
      assistant: { memory: true },
      jobs: noJobs,
    },
    { basePath: "/api/chat", getUser: () => null, logger: { error: () => {} } },
  );

  const env: EvalEnv = {
    db,
    base,
    answerModel: models.answer,
    providers,
    keyFor: (provider) => ({ apiKey: keyOf(provider) }),
    complete: fake ? async () => "yes" : judgeCompletion(models.judge, keyOf),
  };

  const startedAt = new Date().toISOString();
  console.log(
    `Memory eval${fake ? " (fake adapters)" : ""}: ${chosen.length} of ${cases.length} cases, ` +
      `dataset ${datasetRevision.slice(0, 7)}, background ${models.background}, ` +
      `answer ${models.answer}, judge ${models.judge}`,
  );
  let done = 0;
  const results: CaseResult[] = await mapPool(chosen, concurrency, async (evalCase) => {
    const result = await runCase(env, evalCase);
    done += 1;
    const verdict = result.error ? `error: ${result.error}` : result.correct ? "yes" : "no";
    console.log(`  [${done}/${chosen.length}] ${result.questionId} ${result.category}: ${verdict}`);
    return result;
  });

  const { perCategory, overall } = tally(
    results.map((result) => ({ category: result.category, correct: result.correct })),
  );
  console.log("");
  for (const category of categories) {
    const row = perCategory[category];
    console.log(
      `${category.padEnd(28)} ${String(row.correct).padStart(3)}/${String(row.total).padEnd(3)} ${percent(row.accuracy)}`,
    );
  }
  console.log(
    `${"overall".padEnd(28)} ${String(overall.correct).padStart(3)}/${String(overall.total).padEnd(3)} ${percent(overall.accuracy)}`,
  );

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `memory-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify(
      { startedAt, fake, datasetRevision, models, perCategory, overall, cases: results },
      null,
      2,
    ),
  );
  console.log(`\nEvery answer is in ${file}`);
  await db.$client.end();
  // The SDK's Run timers are not all cleared once a Run ends, so the script exits here rather than
  // waiting for them.
  process.exit(0);
}

await main();
