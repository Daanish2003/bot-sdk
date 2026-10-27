// The step-6 ladder eval (spec #587, "The cheapest-first ladder"): does a real Model, under the
// Computer system prompt with the Helper tools, answer a quick question itself, hand research to a
// General Helper and a website task to a Computer-use Helper, relay a Helper's report in one
// Message, and tell the user about a broken tool instead of working around it with a browser? Run it
// with `pnpm -F @ai-chat/bot-sdk eval:ladder`; see eval/turn/README.md.
//
// A Helper started in a run never runs: its job is queued for a day from now, so the run scores the
// main agent's choice alone. The Computer is a provider whose calls succeed with empty output, so the
// Bot's own shell or files call looks like a working tool. Tavily is answered by the eval itself
// with a few short results, too thin to finish a multi-step task.
//
// `--fake` (or EVAL_FAKE=1) plays each case's scripted calls instead of a Model, for checking the
// script without a key. `--limit=<n>` runs the first n cases.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ComputerProvider } from "@botsdk/bot/computer";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import { createFakeAdapter, round, toolCall } from "../../test/support/fake-adapter";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { fail, judgeCompletion, keyFor } from "./judge-model";
import { type LadderCase, ladderCases } from "./ladder-cases";
import { type LadderRunResult, runLadderCase } from "./ladder-run";
import type { Complete } from "./queue-run";
import { formatJudge, tallyQueue } from "./queue-score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/**
 * A Computer whose calls all succeed with nothing in them: an empty directory, a command that
 * exits 0 and prints nothing. The Bot's own `shell` or `files` call then looks like a working
 * tool, not a broken one. A Helper's job never runs (see `main`), so nothing here does real work.
 */
const emptyComputer: ComputerProvider = {
  template: "ladder-eval-empty",
  create: async () => ({ sandboxId: "ladder-eval-sandbox" }),
  endpoint: async (_id, port) => ({ url: `https://${port}-ladder-eval.invalid`, headers: {} }),
  resume: async () => "resumed",
  kill: async () => {},
  pause: async () => {},
  setTimeout: async () => {},
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  readFile: async () => null,
  writeFile: async () => {},
  list: async () => [],
};

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

/** A few short, plausible results for any query: enough for a search to look like it works, not enough to finish a task. */
function tavilyResults(query: string) {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return [
    {
      title: `Best picks for: ${query}`,
      url: `https://www.example-reviews.com/guides/${slug}`,
      content: `A roundup touching on ${query}. It names a few popular models and says prices, warranty terms and delivery vary by seller and city.`,
    },
    {
      title: `${query} - buyer's guide`,
      url: `https://www.example-buyers.org/${slug}`,
      content: `What to look for when comparing options for ${query}: build quality, warranty length, return policy and recent owner reviews.`,
    },
    {
      title: `Owners discuss ${query}`,
      url: `https://forum.example-community.net/t/${slug}`,
      content: `Owners share mixed experiences about ${query}. Several recommend checking each maker's own site for current prices and delivery areas.`,
    },
  ];
}

/** Answers Tavily with a few results for any query, and everything else with the real fetch. */
function tavilyAnswered(real: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.tavily.com/")) return real(input, init);
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    return Response.json({ results: tavilyResults(query) });
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
  // `null`: the Model runs on the owner's ChatGPT plan (eval/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan);

  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? model;
  const judgeKey = fake ? "sk-fake" : keyFor(judgeModel, plan, " (the judge)");
  const complete: Complete = fake
    ? async () => "Verdict: yes\nReason: fake judge"
    : judgeCompletion(judgeModel, judgeKey, plan);

  const db = await prepareSchema(databaseUrlFromEnv());
  /** The fake Model's case for each run, found by the run's own API key. */
  const scripts = new Map<string, LadderCase>();
  const sdk = createComputerSdk({
    db,
    provider: emptyComputer,
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
        : { ...real, linkedCredentials: plan?.linkedCredentials },
  });
  // A Helper's job waits a day, so it never runs: the run scores the main agent's choice.
  const runner = sdk.runner;
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
      if (!fake) return apiKey === null ? null : { apiKey };
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
