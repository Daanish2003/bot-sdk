// The Files eval (ticket #805): real Turns on a real Model, through the real `bot` plugin, each
// started by a Message that carries files. It scores whether a Bot reads what was sent instead of
// asking for it, reads a receipt image, and ignores an instruction inside a file. Run it with
// `pnpm -F @ai-chat/evals eval:files`; see src/files/README.md.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter and the fake
// Computer, which plays each case's `good` script, for checking the harness and the scorers with no
// Model, key or E2B. With `--broken` it plays the `broken` script, what a deliberately broken prompt
// makes a Bot do, and every case must then FAIL: that is how a case is seen to fail before it is
// trusted. `--limit=<n>` runs the first n cases; `--case=<id>` only that case.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { botTrigger, computer as computerTable } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { uploadBotFile } from "@botsdk/bot/bot/conversation";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { isReviewCall, passVerdict, verdictRound } from "@botsdk/testing/fake-reviewer";
import { sendAndFollow } from "@ai-chat/test-support/follow-send";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
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
import { type FilesCase, filesCases } from "./cases";
import { type Call, type Expect, type Score, scoreFiles, tallyFiles } from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Bots' Model unless told otherwise: the step's default on OpenRouter, which can see images. */
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
  suite: FilesCase["suite"];
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
  if (only && !filesCases.some((evalCase) => evalCase.id === only)) {
    fail(`--case must be one of ${filesCases.map((evalCase) => evalCase.id).join(", ")}`);
  }
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (src/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  const computerProvider = fake
    ? fakeComputerProvider().provider
    : localE2bProvider(process.env.EVAL_TEMPLATE ?? defaultTemplate);
  /** The fake Model, one adapter per run (found by its API key). */
  const adapters = new Map<string, AnyTextAdapter>();
  const sdk = createComputerSdk({
    db,
    provider: computerProvider,
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
      const evalCase = filesCases.find((c) => c.id === caseId)!;
      const steps = broken ? evalCase.broken : evalCase.good;
      adapters.set(
        key,
        passingReviews(
          createFakeAdapter({
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

  /** Kills the user's sandbox and removes the row, as the computer eval does, so the E2B pool frees up. */
  async function dropComputer(userId: string) {
    const [row] = await db.select().from(computerTable).where(eq(computerTable.userId, userId));
    if (row?.sandboxId)
      await computerProvider.kill(row.sandboxId).catch((caught) => {
        console.log(`      could not kill sandbox ${row.sandboxId}: ${caught}`);
      });
    await db.delete(computerTable).where(eq(computerTable.userId, userId));
  }

  async function runCase(evalCase: FilesCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const base = {
      caseId: evalCase.id,
      suite: evalCase.suite,
      repeat,
      expected: evalCase.expect,
    };
    let toolCalls: Call[] = [];
    let userId: string | undefined;
    try {
      const made = await freshBot(env, evalCase.id, repeat);
      userId = made.userId;
      // Uploaded as the web app does, then sent by id: the Turn copies them into uploads/.
      const files: string[] = [];
      for (const file of evalCase.files) {
        const bytes = typeof file.bytes === "string" ? file.bytes : new Uint8Array(file.bytes);
        const sent = await uploadBotFile(
          sdk,
          made.userId,
          new File([bytes], file.name, { type: file.type }),
        );
        files.push(sent.id);
      }
      const id = uuidv7();
      for await (const _ of await sendAndFollow(sdk, {
        userId: made.userId,
        botId: made.bot.id,
        id,
        text: evalCase.message,
        files,
      })) {
        // Drained: the stream ends when the Turn does.
      }
      const [trigger] = await db
        .select({ turnId: botTrigger.turnId })
        .from(botTrigger)
        .where(eq(botTrigger.id, id));
      if (!trigger?.turnId) throw new Error("No Turn took the Message");
      const turn = await waitForTurn(env, trigger.turnId, 5 * 60_000);
      toolCalls = toolCallsOf(turn.transcript);
      const score = scoreFiles(evalCase.expect, { status: turn.status, calls: toolCalls });
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
    } finally {
      if (userId && !fake) {
        await dropComputer(userId).catch((caught) =>
          console.log(`      could not drop the Computer: ${caught}`),
        );
      }
    }
  }

  const chosen = filesCases.filter((evalCase) => !only || evalCase.id === only);
  const cases = limit === undefined ? chosen : chosen.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Files eval${fake ? (broken ? " (fake adapter, BROKEN scripts)" : " (fake adapter)") : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
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
    console.log(`${evalCase.id.padEnd(20)} ${passed}/${own.length} passed`);
  }
  const tally = tallyFiles(results);
  for (const [name, row] of Object.entries(tally.suites)) {
    console.log(`${name.padEnd(8)} ${row.passed}/${row.total} passed`);
  }
  console.log(`\nAll: ${tally.all.passed}/${tally.all.total} passed.`);
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
    `files-${broken ? "broken-" : ""}${startedAt.replace(/[:.]/g, "-")}.json`,
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
  const ok = broken ? caught === results.length : results.every((result) => result.score.passed);
  process.exit(ok ? 0 : 1);
}

await main();
