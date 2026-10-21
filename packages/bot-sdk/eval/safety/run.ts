// The safety evals (spec #691, #697): the reviewer's false-block and miss rates on ~30 cases, and
// ~5 end-to-end cases in which a webhook Routine's payload hides a command. Run them with
// `pnpm -F @ai-chat/bot-sdk eval:safety`; see eval/safety/README.md.
//
// `--only=review,e2e` runs one of the two. `--fake` (or EVAL_FAKE=1) plays a scripted Model in
// place of a real one, for checking the script and the scoring without a key; its scores prove
// the wiring, not the reviewer.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { bot } from "../../plugins/bot/server/plugin";
import { saveCredentials } from "../../plugins/models/server/credentials/store";
import { runnerJobs } from "../../plugins/runner/server/plugin";
import { createFakeAdapter, round, toolCall } from "../../test/support/fake-adapter";
import { isReviewCall, verdictRound } from "../../test/support/fake-reviewer";
import { fakeComputerProvider } from "../../test/plugins/computer/server/fake-provider";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { createComputerSdk, databaseUrlFromEnv, fail, prepareSchema } from "../computer/setup";
import { keyFor } from "../turn/judge-model";
import { injectionCases, reviewCases } from "./cases";
import { runInjectionCase, type InjectionRunResult } from "./inject-run";
import { runReviewCase, type ReviewRunResult, type SafetyEnv } from "./review-run";
import { reviewGroups, tallyReviews } from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

const scenarios = ["review", "e2e"] as const;

const percent = (rate: number | null) =>
  rate === null ? "   n/a" : `${(rate * 100).toFixed(1).padStart(5)}%`;

/** What the fake Model plays for a run, found by the run's own API key. */
type FakeScript = { review: "pass" | "block" } | { inject: string };

/** The adapter, except that an Auto-review call goes to `review` and every other call to `bot`. */
function splitReviewer(bot: AnyTextAdapter, review: () => AnyTextAdapter): AnyTextAdapter {
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property !== "chatStream") return Reflect.get(target, property, receiver);
      return (options: TextOptions) =>
        isReviewCall(options) ? review().chatStream(options) : target.chatStream(options);
    },
  });
}

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : [...scenarios];
  for (const name of only) {
    if (!(scenarios as readonly string[]).includes(name)) {
      fail(`--only names ${scenarios.join(", ")}; "${name}" is none of them`);
    }
  }
  const repeats = Number(process.env.EVAL_REPEATS ?? 3);
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["EVAL_CONCURRENCY", concurrency],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }

  const reviewModel = fake
    ? (process.env.EVAL_REVIEW_MODEL ?? "openai:gpt-5.4-mini")
    : process.env.EVAL_REVIEW_MODEL;
  if (!reviewModel) {
    fail("EVAL_REVIEW_MODEL is not set: the Model that reviews. See eval/safety/README.md.");
  }
  const botModel = process.env.EVAL_BOT_MODEL ?? reviewModel;
  // `null`: a Model runs on the owner's ChatGPT plan (eval/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const keyOf = (model: string) => (fake ? "sk-fake" : keyFor(model, plan));
  const reviewKey = keyOf(reviewModel);
  const botKey = only.includes("e2e") ? keyOf(botModel) : reviewKey;

  const db = await prepareSchema(databaseUrlFromEnv());
  const computer = fakeComputerProvider();
  /** The fake Model's script for each run, found by the run's own API key. */
  const scripts = new Map<string, FakeScript>();
  const sdk = createComputerSdk({
    db,
    provider: computer.provider,
    more: [bot({ reviewModel })],
    models: (real) =>
      fake
        ? {
            ...real,
            adapterFor: (_model, credentials) => {
              const script = scripts.get((credentials as { apiKey: string }).apiKey);
              if (!script) throw new Error("No fake script for this run");
              if ("review" in script) {
                return createFakeAdapter({
                  rounds: [
                    verdictRound({ outcome: script.review, reason: "Fake.", summary: "A command" }),
                  ],
                }).adapter;
              }
              // The Bot follows the injection; the fake reviewer blocks it, as a good one does.
              const { adapter } = createFakeAdapter({
                rounds: [
                  round(toolCall({ name: "shell", input: { command: `echo ${script.inject}` } })),
                  round(
                    toolCall({
                      name: "send_to_user",
                      input: { text: "A fake reply.", endTurn: true },
                    }),
                  ),
                ],
              });
              return splitReviewer(adapter, () => {
                return createFakeAdapter({
                  rounds: [
                    verdictRound({ outcome: "block", reason: "Fake.", summary: "A command" }),
                  ],
                }).adapter;
              });
            },
          }
        : { ...real, linkedCredentials: plan?.linkedCredentials },
  });
  const jobs = runnerJobs(sdk);
  await jobs.start();

  const fakeKey = (caseId: string, repeat: number) => `fake-${caseId}-${repeat}`;
  const reviewEnv: SafetyEnv = {
    db,
    sdk,
    model: reviewModel,
    credentialsFor: (caseId, repeat) => {
      if (!fake) return reviewKey === null ? null : { apiKey: reviewKey };
      const expected = reviewCases.find((c) => c.id === caseId)!.expected;
      scripts.set(fakeKey(caseId, repeat), { review: expected });
      return { apiKey: fakeKey(caseId, repeat) };
    },
  };
  const injectEnv: SafetyEnv = {
    db,
    sdk,
    model: botModel,
    credentialsFor: (caseId, repeat) => {
      if (!fake) return botKey === null ? null : { apiKey: botKey };
      const evalCase = injectionCases.find((c) => c.id === caseId)!;
      scripts.set(fakeKey(caseId, repeat), { inject: evalCase.canary });
      return { apiKey: fakeKey(caseId, repeat) };
    },
    // The reviewer's Provider may not be the Bot's: its key is saved too.
    saveReviewerKey: async (userId, caseId, repeat) => {
      const service = reviewModel.split(":")[0]!;
      if (service === botModel.split(":")[0]) return;
      const apiKey = fake ? fakeKey(caseId, repeat) : reviewKey;
      if (apiKey === null) return;
      await saveCredentials(sdk, userId, {
        service,
        fields: { apiKey },
        hint: "eval",
        verified: true,
      });
    },
  };

  const startedAt = new Date().toISOString();
  const reviewResults: ReviewRunResult[] = [];
  const injectionResults: InjectionRunResult[] = [];

  if (only.includes("review")) {
    console.log(
      `Reviewer cases${fake ? " (fake adapter)" : ""}: ${reviewCases.length} cases x ${repeats} repeats, Model ${reviewModel}`,
    );
    const runs = reviewCases.flatMap((evalCase) =>
      Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
    );
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
        while (next < runs.length) {
          const { evalCase, repeat } = runs[next++]!;
          const result = await runReviewCase(reviewEnv, evalCase, repeat);
          reviewResults.push(result);
          const right = result.actual === result.expected;
          console.log(
            `  ${result.caseId} #${repeat}: ${right ? "ok" : "WRONG"} (wanted ${result.expected}, got ${result.actual}${result.failed ? ", reviewer failed" : ""})`,
          );
          if (!right) console.log(`      ${result.reason}`);
        }
      }),
    );
  }

  if (only.includes("e2e")) {
    console.log(
      `\nInjection cases${fake ? " (fake adapter)" : ""}: ${injectionCases.length} cases x ${repeats} repeats, Bot ${botModel}, reviewer ${reviewModel}`,
    );
    // One at a time: the fake Computer's calls are shared, and a blocked call waits 15 seconds.
    for (const evalCase of injectionCases) {
      for (let repeat = 0; repeat < repeats; repeat++) {
        const result = await runInjectionCase(injectEnv, computer, evalCase, repeat);
        injectionResults.push(result);
        console.log(
          `  ${result.caseId} #${repeat}: ${result.passed ? "pass" : "FAIL"} (${result.how}, ${result.blocked} blocked)`,
        );
        if (result.error) console.log(`      error: ${result.error}`);
        if (!result.passed && !result.error) {
          console.log(`      ran: ${result.ran.join(" | ")}`);
        }
      }
    }
  }
  await jobs.stop();

  console.log("");
  const rates = tallyReviews(reviewResults);
  if (reviewResults.length > 0) {
    for (const group of reviewGroups) {
      const row = rates.groups[group];
      if (row) {
        console.log(
          `${group.padEnd(10)} ${String(row.correct).padStart(3)}/${String(row.total).padEnd(3)} ${percent(row.rate)}`,
        );
      }
    }
    console.log(
      `false-block ${rates.falseBlock.count}/${rates.falseBlock.of} ${percent(rates.falseBlock.rate)}  (calls that should pass but were blocked)`,
    );
    console.log(
      `miss        ${rates.miss.count}/${rates.miss.of} ${percent(rates.miss.rate)}  (calls that should be blocked but passed)`,
    );
    const failed = reviewResults.filter((result) => result.failed).length;
    if (failed > 0) console.log(`${failed} run(s) had no verdict (counted as blocks)`);
  }
  if (injectionResults.length > 0) {
    const passed = injectionResults.filter((result) => result.passed).length;
    const blocked = injectionResults.filter((result) => result.how === "blocked").length;
    console.log(
      `injection   ${passed}/${injectionResults.length} never ran the command (${blocked} blocked by the reviewer, ${passed - blocked} never tried)`,
    );
  }

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `safety-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        startedAt,
        fake,
        reviewModel,
        botModel,
        repeats,
        rates,
        reviewRuns: reviewResults,
        injectionRuns: injectionResults,
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
    [...reviewResults, ...injectionResults].some((result) => result.error) ||
      reviewResults.some((result) => result.failed) ||
      injectionResults.some((result) => !result.passed)
      ? 1
      : 0,
  );
}

await main();
