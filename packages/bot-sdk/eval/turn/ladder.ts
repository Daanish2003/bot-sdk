// The step-6 ladder eval (spec #587, "The cheapest-first ladder"): does a real Model, under the
// Computer system prompt with the Helper tools, answer a quick question itself, hand research to a
// General Helper and a website task to a Computer-use Helper, relay a Helper's report in one
// Message, and tell the user about a broken tool instead of working around it with a browser? Run it
// with `pnpm -F @ai-chat/bot-sdk eval:ladder`; see eval/turn/README.md.
//
// A Helper started in a run never runs: its job is queued for a day from now, so the run scores the
// main agent's choice alone. The Computer is a provider that fails every call, since no case should
// reach it. Tavily is answered by the eval itself.
//
// `--fake` (or EVAL_FAKE=1) plays each case's scripted calls instead of a Model, for checking the
// script without a key. `--limit=<n>` runs the first n cases.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bot } from "../../plugins/bot/server/plugin";
import type { ComputerProvider } from "../../plugins/computer/server";
import { runnerJobs } from "../../plugins/runner/server/plugin";
import { createFakeAdapter, round, toolCall } from "../../test/support/fake-adapter";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { fail, judgeCompletion, keyVariables } from "./judge-model";
import { type LadderCase, ladderCases } from "./ladder-cases";
import { type LadderRunResult, runLadderCase } from "./ladder-run";
import type { Complete } from "./queue-run";
import { formatJudge, tallyQueue } from "./queue-score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** A Computer no case should reach: every call on it fails. */
const unusedComputer = new Proxy(
  { template: "ladder-eval-unused" },
  {
    get: (target, key) =>
      key in target
        ? target[key as keyof typeof target]
        : () => Promise.reject(new Error("The ladder eval never reaches a Computer")),
  },
) as unknown as ComputerProvider;

/** What the fake Model plays for a case: its tool calls, one per model call, then a reply. */
function fakeScript(evalCase: LadderCase) {
  return [
    ...evalCase.fake.calls.map((call) => round(toolCall(call))),
    round(
      toolCall({
        name: "send_to_user",
        input: { text: evalCase.fake.reply, endTurn: true },
      }),
    ),
  ];
}

/** Answers Tavily with one result for any query, and everything else with the real fetch. */
function tavilyAnswered(real: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.tavily.com/")) return real(input, init);
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    return Response.json({
      results: [
        {
          title: "Search result",
          url: "https://example.com/result",
          content: `A page about: ${query}`,
        },
      ],
    });
  };
}

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  const repeats = Number(process.env.EVAL_REPEATS ?? 3);
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["EVAL_CONCURRENCY", concurrency],
    ["--limit", limit ?? 1],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  const model = fake
    ? (process.env.EVAL_BOT_MODEL ?? "openai:gpt-5.4-mini")
    : process.env.EVAL_BOT_MODEL;
  if (!model) fail("EVAL_BOT_MODEL is not set. See packages/bot-sdk/eval/turn/README.md.");
  const provider = model.split(":")[0]!;
  const apiKey = fake ? "sk-fake" : process.env[keyVariables[provider] ?? ""];
  if (!apiKey) fail(`${keyVariables[provider] ?? `A key for ${provider}`} is not set`);

  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? model;
  const judgeProvider = judgeModel.split(":")[0]!;
  const judgeKey = fake ? "sk-fake" : process.env[keyVariables[judgeProvider] ?? ""];
  if (!judgeKey)
    fail(`${keyVariables[judgeProvider] ?? `A key for ${judgeProvider}`} is not set (the judge)`);
  const complete: Complete = fake
    ? async () => "Verdict: yes\nReason: fake judge"
    : judgeCompletion(judgeModel, judgeKey);

  const db = await prepareSchema(databaseUrlFromEnv());
  /** The fake Model's case for each run, found by the run's own API key. */
  const scripts = new Map<string, LadderCase>();
  const sdk = createComputerSdk({
    db,
    provider: unusedComputer,
    more: [bot()],
    wrapFetch: tavilyAnswered,
    models: (real) =>
      fake
        ? {
            ...real,
            adapterFor: (_model, credentials) => {
              const evalCase = scripts.get((credentials as { apiKey: string }).apiKey);
              if (!evalCase) throw new Error("No fake script for this run");
              return createFakeAdapter({ rounds: fakeScript(evalCase) }).adapter;
            },
          }
        : real,
  });
  // A Helper's job waits a day, so it never runs: the run scores the main agent's choice.
  const runner = sdk.plugin("runner");
  const enqueueIn = runner.enqueueIn;
  runner.enqueueIn = (tx, name, payload, options = {}) =>
    enqueueIn(
      tx,
      name,
      payload,
      name === "bot.helper"
        ? { ...options, runAfter: new Date(Date.now() + 24 * 60 * 60 * 1000) }
        : options,
    );
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
        ladderCases.find((c) => c.id === caseId)!,
      );
      return { apiKey: key };
    },
  };

  const cases = limit === undefined ? ladderCases : ladderCases.slice(0, limit);
  const startedAt = new Date().toISOString();
  console.log(
    `Ladder eval${fake ? " (fake adapter)" : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}, judge ${judgeModel}`,
  );
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const results: LadderRunResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
      while (next < runs.length) {
        const { evalCase, repeat } = runs[next++]!;
        const result = await runLadderCase(env, complete, evalCase, repeat);
        results.push(result);
        console.log(
          `  ${result.caseId} #${repeat}: structural ${result.structural.passed ? "pass" : "FAIL"}, judge ${result.judge ? (result.judge.correct ? "yes" : "NO") : "n/a"}`,
        );
        for (const reason of result.structural.reasons) console.log(`      ${reason}`);
        if (result.judge) console.log(`      judge: ${result.judge.reason}`);
      }
    }),
  );
  await jobs.stop();

  const rates = tallyQueue(
    results.map((r) => ({
      caseId: r.caseId,
      structural: r.structural.passed,
      judge: r.judge?.correct ?? null,
    })),
  );
  console.log("");
  for (const evalCase of cases) {
    const row = rates[evalCase.id];
    if (row) {
      console.log(
        `${evalCase.id.padEnd(16)} structural ${row.structural}/${row.runs}, ${formatJudge(row)}`,
      );
    }
  }

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `ladder-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify({ startedAt, fake, model, judgeModel, repeats, rates, runs: results }, null, 2),
  );
  console.log(`\nEvery run is in ${file}`);
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  // A run that errored (a bad key, a rate limit) is not a Model failure: exit non-zero so it is seen.
  process.exit(results.some((result) => result.error) ? 1 : 0);
}

await main();
