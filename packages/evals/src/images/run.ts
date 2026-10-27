import { sendAndFollow } from "@ai-chat/test-support/follow-send";
// The Images eval (spec #801, ticket #809): real Turns on a real Model, through the real `bot` plugin
// with a Host Image Model. It scores whether a Bot generates an image and sends it in the same Turn
// when asked, makes none when not asked, and edits the earlier file for "change that image". Run it
// with `pnpm -F @ai-chat/evals eval:images`; see src/images/README.md.
//
// The Computer is the fake one, and the Image Model is the fake image adapter, in every mode: what is
// scored is what the Bot asks for, not the picture.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter, which plays each
// case's `good` script, for checking the harness and the scorers with no Model or key. With
// `--broken` it plays the `broken` script, and every case must then FAIL: that is how a case is seen
// to fail before it is trusted. `--limit=<n>` runs the first n cases; `--case=<id>` only that case.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { botTrigger } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { computerOf } from "@botsdk/bot/bot/agent-loop";
import { fakeImageAdapter, fakePngBase64 } from "@botsdk/bot/models/internal";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { isReviewCall, passVerdict, verdictRound } from "@botsdk/testing/fake-reviewer";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { fail, keyFor } from "../turn/judge-model";
import { freshBot, seedHistory, type TurnEnv } from "../turn/case";
import { toolCallsOf } from "../turn/routine-score";
import { waitForTurn } from "../turn/routine-run";
import { type ImagesCase, imagesCases } from "./cases";
import { type Call, type Expect, type Score, scoreImages, tallyImages } from "./score";
import { botDirectory } from "@botsdk/bot/bot/conversation";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Bots' Model unless told otherwise: the step's default on OpenRouter. */
const defaultModel = "openrouter:anthropic/claude-sonnet-5.5";

/** The Host's one Image Model, drawn by the fake image adapter. */
const imageModel = "gpt-image-1-mini";

/** The adapter, except that an Auto-review call gets a pass and no scripted round. */
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
  toolCalls: Call[];
  ms: number;
  error?: string;
};

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const broken = process.argv.includes("--broken");
  if (broken && !fake)
    fail("--broken plays the broken script of the fake Model: use it with --fake");
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  const only = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
  const repeats = Number(process.env.EVAL_REPEATS ?? 3);
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["EVAL_CONCURRENCY", concurrency],
    ["--limit", limit ?? 1],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  if (only && !imagesCases.some((evalCase) => evalCase.id === only)) {
    fail(`--case must be one of ${imagesCases.map((evalCase) => evalCase.id).join(", ")}`);
  }
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (src/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  /** The fake Model, one adapter per run (found by its API key). */
  const adapters = new Map<string, AnyTextAdapter>();
  const sdk = createComputerSdk({
    db,
    provider: fakeComputerProvider().provider,
    models: (real) => ({
      ...(fake
        ? {
            ...real,
            adapterFor: (_model, credentials) => {
              const adapter = adapters.get((credentials as { apiKey: string }).apiKey);
              if (!adapter) throw new Error("No fake script for this run");
              return adapter;
            },
          }
        : { ...real, linkedCredentials: plan?.linkedCredentials }),
      hostProviders: [
        ...real.hostProviders,
        {
          provider: "openai",
          credentials: { apiKey: "sk-eval-host-image" },
          models: [],
          imageModels: [
            { modelId: imageModel, size: "1024x1024", quality: "medium", pricePerImageUsd: 0.01 },
          ],
        },
      ],
      defaultImageModel: `openai:${imageModel}`,
      imageAdapterFor: () => fakeImageAdapter(),
    }),
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
      const evalCase = imagesCases.find((c) => c.id === caseId)!;
      const steps = broken ? evalCase.broken : evalCase.good;
      adapters.set(
        key,
        passingReviews(
          createFakeAdapter({
            // A last quiet round: sending a file the fake never made is refused, and the Model is called again.
            rounds: [
              ...steps.map((step) => round(toolCall({ name: step.name, input: step.input }))),
              round(),
            ],
          }).adapter,
        ),
      );
      return { apiKey: key };
    },
  };

  async function runCase(evalCase: ImagesCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const base = { caseId: evalCase.id, gating: true, repeat, expected: evalCase.expect };
    let toolCalls: Call[] = [];
    try {
      const { userId, bot: made, found } = await freshBot(env, evalCase.id, repeat);
      await seedHistory(
        db,
        { botId: made.id, conversationId: found!.conversationId },
        evalCase.history,
      );
      if (evalCase.seedImage) {
        await computerOf(sdk, userId).writeFile(
          `${botDirectory(made.id)}/${evalCase.seedImage}`,
          new Uint8Array(Buffer.from(fakePngBase64, "base64")),
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
      const score = scoreImages(evalCase.expect, { status: turn.status, calls: toolCalls });
      return { ...base, score, toolCalls, ms: Date.now() - started };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      return {
        ...base,
        score: { passed: false, reasons: [`error: ${error}`] },
        toolCalls,
        ms: Date.now() - started,
        error,
      };
    }
  }

  const chosen = imagesCases.filter((evalCase) => !only || evalCase.id === only);
  const cases = limit === undefined ? chosen : chosen.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Images eval${fake ? (broken ? " (fake adapter, BROKEN scripts)" : " (fake adapter)") : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
  );

  const results: RunResult[] = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
    while (next < runs.length) {
      const { evalCase, repeat } = runs[next++]!;
      const result = await runCase(evalCase, repeat);
      results.push(result);
      console.log(
        `  [${results.length}/${runs.length}] ${evalCase.id} #${repeat}: ${result.score.passed ? "pass" : "FAIL"}`,
      );
      for (const reason of result.score.reasons) console.log(`      ${reason}`);
    }
  });
  await Promise.all(lanes);

  console.log("");
  for (const evalCase of cases) {
    const own = results.filter((result) => result.caseId === evalCase.id);
    const passed = own.filter((result) => result.score.passed).length;
    console.log(`${evalCase.id.padEnd(22)} ${passed}/${own.length} passed`);
  }
  const tally = tallyImages(results);
  console.log(`\nGating: ${tally.gating.passed}/${tally.gating.total} passed.`);
  // The broken scripts must all fail. A run that errored is not a failed score, so it doesn't count.
  // Caught by the scorer, not by a Turn that broke: its reasons must not be only "the Turn ended ...".
  const caught = results.filter(
    (result) =>
      !result.score.passed &&
      !result.error &&
      result.score.reasons.some((reason) => !reason.startsWith("the Turn ended")),
  ).length;
  if (broken)
    console.log(`Broken scripts caught: ${caught}/${results.length} (all must be caught).`);

  await mkdir(resultsDir, { recursive: true });
  const file = join(
    resultsDir,
    `images-${broken ? "broken-" : ""}${startedAt.replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(
    file,
    JSON.stringify({ startedAt, fake, broken, model, repeats, tally, runs: results }, null, 2),
  );
  console.log(`\nEvery run (tool calls, scores) is in ${file}`);
  await jobs.stop();
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  const ok = broken
    ? caught === results.length
    : results.every((result) => !result.gating || result.score.passed);
  process.exit(ok ? 0 : 1);
}

await main();
