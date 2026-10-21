// The step-8 evals (spec #665, #678, "Context engineering"): cache stability, Summaries and tool
// search with a real Model. Run them with `pnpm -F @ai-chat/bot-sdk eval:context`; see
// eval/turn/README.md.
//
// `--only=cache,summary,tools` runs some of the three. `--fake` (or EVAL_FAKE=1) plays a scripted
// Model in place of a real one, for checking the script and the scoring without a key; its cache
// numbers are the script's own, so it proves the wiring, not the cache.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bot } from "../../plugins/bot/server/plugin";
import { memory } from "../../plugins/memory/server/plugin";
import { runnerJobs } from "../../plugins/runner/server/plugin";
import { fakeComputerProvider } from "../../test/plugins/computer/server/fake-provider";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { toolSearchCases } from "./context-cases";
import {
  type ContextEnv,
  type ContextRunResult,
  runCacheCase,
  runSummaryCase,
  runToolSearchCase,
} from "./context-run";
import { fail, judgeCompletion, keyFor } from "./judge-model";
import type { Complete } from "./queue-run";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

const scenarios = ["cache", "summary", "tools"] as const;

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : [...scenarios];
  for (const name of only) {
    if (!(scenarios as readonly string[]).includes(name)) {
      fail(`--only names ${scenarios.join(", ")}; "${name}" is none of them`);
    }
  }
  const repeatsEnv = process.env.EVAL_REPEATS;
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 3);
  for (const [name, value] of [
    ["EVAL_REPEATS", repeatsEnv === undefined ? 1 : Number(repeatsEnv)],
    ["EVAL_CONCURRENCY", concurrency],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  // A summary run sends 100,000+ tokens and a cache run needs a direct key, so each runs once
  // unless told otherwise; the tool search cases are cheap, so they run three times.
  const repeatsOf = (scenario: (typeof scenarios)[number]) =>
    repeatsEnv === undefined ? (scenario === "tools" ? 3 : 1) : Number(repeatsEnv);

  const model = fake
    ? (process.env.EVAL_BOT_MODEL ?? "anthropic:claude-haiku-4-5")
    : process.env.EVAL_BOT_MODEL;
  if (!model) fail("EVAL_BOT_MODEL is not set. See packages/bot-sdk/eval/turn/README.md.");
  if (only.includes("cache") && !model.startsWith("anthropic:")) {
    fail(
      `The cache eval needs a direct Anthropic Model ("anthropic:<model>"), not "${model}": ` +
        "its warming call and cache reads are Anthropic's.",
    );
  }
  // `null`: the Model runs on the owner's ChatGPT plan (eval/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan);
  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? model;
  const judgeKey = fake ? "sk-fake" : keyFor(judgeModel, plan, " (the judge)");
  const complete: Complete = fake
    ? async () => "Verdict: yes\nReason: fake judge"
    : judgeCompletion(judgeModel, judgeKey, plan);

  const db = await prepareSchema(databaseUrlFromEnv());
  /** The fake Model, one adapter per run (found by its API key), playing its rounds across calls. */
  const adapters: ContextEnv["adapters"] = new Map();
  const sdk = createComputerSdk({
    db,
    provider: fakeComputerProvider().provider,
    more: [bot(), memory()],
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
  const env: ContextEnv = { db, sdk, model, fake, apiKey, adapters, complete };

  const startedAt = new Date().toISOString();
  console.log(
    `Context eval${fake ? " (fake adapter)" : ""}: ${only.join(", ")}, Model ${model}, judge ${judgeModel}`,
  );
  const results: ContextRunResult[] = [];
  const record = (result: ContextRunResult) => {
    results.push(result);
    const verdict = result.judge ? `, judge ${result.judge.correct ? "yes" : "NO"}` : "";
    console.log(
      `  ${result.caseId} #${result.repeat}: ${result.score.passed ? "pass" : "FAIL"}${verdict}`,
    );
    for (const reason of result.score.reasons) console.log(`      ${reason}`);
    if (result.judge && !result.judge.correct) console.log(`      judge: ${result.judge.reason}`);
  };

  // Cache and Summary runs go one at a time: each is big, and a rate limit is not a Model failure.
  if (only.includes("cache")) {
    for (let repeat = 0; repeat < repeatsOf("cache"); repeat++)
      record(await runCacheCase(env, repeat));
  }
  if (only.includes("summary")) {
    for (let repeat = 0; repeat < repeatsOf("summary"); repeat++) {
      record(await runSummaryCase(env, repeat));
    }
  }
  if (only.includes("tools")) {
    const runs = toolSearchCases.flatMap((evalCase) =>
      Array.from({ length: repeatsOf("tools") }, (_, repeat) => ({ evalCase, repeat })),
    );
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
        while (next < runs.length) {
          const { evalCase, repeat } = runs[next++]!;
          record(await runToolSearchCase(env, evalCase, repeat));
        }
      }),
    );
  }
  await jobs.stop();

  console.log("");
  const ids = [...new Set(results.map((result) => result.caseId))];
  for (const id of ids) {
    const own = results.filter((result) => result.caseId === id);
    const passed = own.filter((result) => result.score.passed).length;
    const judged = own.filter((result) => result.judge);
    const judge = judged.length
      ? `, judge ${judged.filter((result) => result.judge!.correct).length}/${judged.length}`
      : "";
    console.log(`${id.padEnd(16)} ${passed}/${own.length}${judge}`);
  }

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `context-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify({ startedAt, fake, model, judgeModel, runs: results }, null, 2),
  );
  console.log(`\nEvery run is in ${file}`);
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  // A run that errored (a bad key, a rate limit) is not a Model failure: exit non-zero so it is seen.
  process.exit(results.some((result) => result.error) ? 1 : 0);
}

await main();
