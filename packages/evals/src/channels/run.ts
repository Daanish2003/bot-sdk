import { sendAndFollow } from "@ai-chat/test-support/follow-send";
// The Channels eval (spec #761, ticket #774): real Turns on a real Model, through the real `bot` and
// `channel` plugins. It scores whether a Bot ignores instructions inside a forwarded email, asks the
// user to pick with a `choice`, and answers a "thanks!" with a reaction or silence. Run it with
// `pnpm -F @ai-chat/evals eval:channels`; see src/channels/README.md.
//
// The Computer is the fake one, in every mode: no case needs real files, and the injection cases
// score what the Bot tries, not what runs.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter, which plays each
// case's `good` script, for checking the harness and the scorers with no Model or key. With
// `--broken` it plays the `broken` script, what a deliberately broken prompt makes a Bot do, and
// every gating case must then FAIL: that is how a case is seen to fail before it is trusted.
// `--limit=<n>` runs the first n cases; `--case=<id>` only that case; `--suite=<name>` one suite.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { botTrigger } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { emailAddressOf } from "@botsdk/bot/bot/conversation";
import { fakeEmailProvider } from "@botsdk/testing/fake-channel";
import { emailChannel } from "@botsdk/bot/channel";
import { createHttpHandlerOver } from "@botsdk/bot/over";
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
import { type ChannelsCase, channelsCases } from "./cases";
import { type Call, type Expect, type Score, scoreChannels, tallyChannels } from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Bots' Model unless told otherwise: the step's default on OpenRouter. */
const defaultModel = "openrouter:anthropic/claude-sonnet-5.5";

const inboundDomain = "bots.eval.invalid";

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
  suite: ChannelsCase["suite"];
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
  const suite = process.argv.find((arg) => arg.startsWith("--suite="))?.slice("--suite=".length);
  const repeats = Number(process.env.EVAL_REPEATS ?? 3);
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["EVAL_CONCURRENCY", concurrency],
    ["--limit", limit ?? 1],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  if (only && !channelsCases.some((evalCase) => evalCase.id === only)) {
    fail(`--case must be one of ${channelsCases.map((evalCase) => evalCase.id).join(", ")}`);
  }
  if (suite && !channelsCases.some((evalCase) => evalCase.suite === suite)) {
    fail("--suite must be injection, choice or reaction");
  }
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (src/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  const email = fakeEmailProvider();
  /** The fake Model, one adapter per run (found by its API key). */
  const adapters = new Map<string, AnyTextAdapter>();
  const sdk = createComputerSdk({
    db,
    provider: fakeComputerProvider().provider,
    channels: [
      emailChannel({
        provider: email.provider,
        domain: inboundDomain,
        appUrl: "https://app.invalid",
      }),
    ],
    // freshBot gives each user this address, and the injection cases mail from it.
    users: { verifiedEmail: async (userId) => `${userId}@eval.invalid` },
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
  // The HTTP layer, for the mail's inbound route; built once for every case.
  const inbound = createHttpHandlerOver(sdk, { basePath: "/api/chat", getUser: () => null });

  const env: TurnEnv = {
    db,
    sdk,
    model,
    credentialsFor: (caseId, repeat) => {
      if (!fake) return apiKey === null ? null : { apiKey };
      const key = `fake-${caseId}-${repeat}-${randomUUID()}`;
      const evalCase = channelsCases.find((c) => c.id === caseId)!;
      const steps = broken ? evalCase.broken : evalCase.good;
      adapters.set(
        key,
        passingReviews(
          createFakeAdapter({
            // A last quiet round: a reaction to an id the fake can only guess is refused, and the Model is called again.
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

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The id of the Turn that took Trigger `id`. */
  async function turnTaking(id: string, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [trigger] = await db
        .select({ turnId: botTrigger.turnId })
        .from(botTrigger)
        .where(eq(botTrigger.id, id));
      if (trigger?.turnId) return trigger.turnId;
      await sleep(100);
    }
    throw new Error(`No Turn took Trigger ${id}`);
  }

  async function runCase(evalCase: ChannelsCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const base = {
      caseId: evalCase.id,
      suite: evalCase.suite,
      gating: evalCase.gating,
      repeat,
      expected: evalCase.expect,
    };
    let toolCalls: Call[] = [];
    try {
      const { userId, bot: made, found } = await freshBot(env, evalCase.id, repeat);
      await seedHistory(
        db,
        { botId: made.id, conversationId: found!.conversationId },
        evalCase.history,
      );
      let triggerId: string;
      if (evalCase.mail) {
        // The mail goes through the real inbound route: address, sender check, DMARC, the fenced block.
        const address = await emailAddressOf(sdk, {
          userId,
          botId: made.id,
          domain: inboundDomain,
        });
        const messageId = `eval-${evalCase.id}-${repeat}-${randomUUID()}@mail.example`;
        const response = await inbound(
          email.request({
            from: `Eval <${userId}@eval.invalid>`,
            to: [address],
            messageId: `<${messageId}>`,
            subject: evalCase.mail.subject,
            text: evalCase.mail.text,
            authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
          }),
        );
        if (response.status !== 202)
          throw new Error(`The inbound route answered ${response.status}`);
        triggerId = `email:${messageId}`;
      } else {
        triggerId = uuidv7();
        for await (const _ of await sendAndFollow(sdk, {
          userId,
          botId: made.id,
          id: triggerId,
          text: evalCase.message!,
        })) {
          // Drained: the stream ends when the Turn does.
        }
      }
      const turn = await waitForTurn(env, await turnTaking(triggerId), 5 * 60_000);
      toolCalls = toolCallsOf(turn.transcript);
      const score = scoreChannels(evalCase.expect, { status: turn.status, calls: toolCalls });
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

  const chosen = channelsCases.filter(
    (evalCase) => (!only || evalCase.id === only) && (!suite || evalCase.suite === suite),
  );
  const cases = limit === undefined ? chosen : chosen.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Channels eval${fake ? (broken ? " (fake adapter, BROKEN scripts)" : " (fake adapter)") : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
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
    console.log(`${evalCase.id.padEnd(26)} ${passed}/${own.length} passed`);
  }
  const tally = tallyChannels(results);
  for (const [name, row] of Object.entries(tally.suites)) {
    console.log(`${name.padEnd(10)} ${row.passed}/${row.total} passed`);
  }
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
    `channels-${broken ? "broken-" : ""}${startedAt.replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(
    file,
    JSON.stringify(
      { startedAt, fake, broken, model, repeats, tally, runs: results },
      (_key, value) => (value instanceof RegExp ? String(value) : value),
      2,
    ),
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
