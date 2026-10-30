import { sendAndFollow } from "@ai-chat/test-support/follow-send";
// The Proactive eval (spec #1024, ticket #1032): real Turns on a real Model, through the real `bot`,
// `mcp` and `memory` plugins, each case's user with a "Mail" Connection over the SDK's fake MCP
// server holding scripted inbox items. It scores the Watch (stays quiet, doesn't repeat a Note,
// marks an urgent item urgent, saves a Note the next brief includes, drafts a write with a choice)
// and the first Bot's offer of both Routines. Every Watch run reports its cost from its usage rows.
// Run it with `pnpm -F @ai-chat/evals eval:proactive`; see src/proactive/README.md.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter, which plays each
// Turn's `good` script (and reports fake usage), for checking the harness and the scorers with no
// Model or key. With `--broken` it plays the `broken` script and every case must then FAIL: that is
// how a case is seen to fail before it is trusted. `--limit=<n>` runs the first n cases;
// `--case=<id>` only that case.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { and, asc, eq } from "drizzle-orm";
import type { TextOptions, TokenUsage } from "@tanstack/ai";

import { botRoutine, botTrigger, botTurn, job, usage } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { computerOf } from "@botsdk/bot/bot/agent-loop";
import { defaultTimeZone } from "@botsdk/bot/bot/conversation";
import { routineSnapshot } from "@botsdk/bot/bot/routines";
import { fireKeyPrefix, lockConversation, receive } from "@botsdk/bot/bot/triggers";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import { saveTokens } from "@botsdk/mcp/server/connections";
import { mcp } from "@botsdk/mcp";
import { memory } from "@botsdk/memory";
import { dayOf, notesPath } from "@botsdk/memory/server/bot-memory";
import { createFakeAdapter, round, text, toolCall, withUsage } from "@botsdk/testing/fake-adapter";
import { isReviewCall, passVerdict, verdictRound } from "@botsdk/testing/fake-reviewer";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { type FakeMcpAuth, fakeMcpResource } from "@ai-chat/test-support/fake-mcp-auth";
import { createFakeMcpServer, type FakeMcpServer } from "@ai-chat/test-support/fake-mcp-server";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { fail, keyFor } from "../turn/judge-model";
import { freshBot, type TurnEnv } from "../turn/case";
import { toolCallsOf, turnIdOf } from "../turn/routine-score";
import { waitForTurn } from "../turn/routine-run";
import {
  defaultRoutinePrompts,
  mailServer,
  mailTools,
  type ProactiveCase,
  proactiveCases,
  type ProactiveTurn,
  type Step,
  watchTimes,
  weekdays,
} from "./cases";
import {
  type Call,
  type Cost,
  costOf,
  defaultPrices,
  type Expect,
  type Prices,
  type Score,
  scoreProactive,
  tallyProactive,
} from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Bots' Model unless told otherwise: the step's default on OpenRouter. */
const defaultModel = "openrouter:anthropic/claude-sonnet-5.5";

/** The fake MCP server checks no token itself: each run's server is found by its token. */
const anyToken = { accepts: () => true } as unknown as FakeMcpAuth;

/** What the fake Model reports for each Turn call, so a Watch run has usage rows to price. */
const fakeUsage: TokenUsage = {
  promptTokens: 9_000,
  completionTokens: 150,
  totalTokens: 9_150,
  promptTokensDetails: { cachedTokens: 8_000 },
};

type TurnResult = {
  start: ProactiveTurn["start"]["kind"];
  expected: Expect;
  score: Score;
  toolCalls: Call[];
  /** The Turn's usage rows summed; for a Watch run this is its cost. */
  cost: Cost;
};

type RunResult = {
  caseId: string;
  gating: boolean;
  repeat: number;
  score: Score;
  turns: TurnResult[];
  ms: number;
  error?: string;
};

const pricesFromEnv = (): Prices => {
  const price = (name: string, fallback: number) => {
    const value = process.env[name];
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) fail(`${name} must be a number, 0 or more`);
    return parsed;
  };
  return {
    input: price("EVAL_PRICE_INPUT", defaultPrices.input),
    output: price("EVAL_PRICE_OUTPUT", defaultPrices.output),
    cacheRead: price("EVAL_PRICE_CACHE_READ", defaultPrices.cacheRead),
    cacheWrite: price("EVAL_PRICE_CACHE_WRITE", defaultPrices.cacheWrite),
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (only && !proactiveCases.some((evalCase) => evalCase.id === only)) {
    fail(`--case must be one of ${proactiveCases.map((evalCase) => evalCase.id).join(", ")}`);
  }
  const prices = pricesFromEnv();
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (src/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  /** Each run's fake MCP server, by the access token its user's Connection holds. */
  const servers = new Map<string, FakeMcpServer>();
  const mcpEndpoint = new URL(fakeMcpResource);
  /** The fake Model's script per run, found by its API key. */
  const scripts = new Map<string, { queue: ReturnType<typeof round>[] }>();
  const adapters = new Map<string, ReturnType<typeof createFakeAdapter>["adapter"]>();
  const sdk = createComputerSdk({
    db,
    provider: fakeComputerProvider().provider,
    features: [
      mcp({
        servers: [
          {
            ...mailServer,
            url: fakeMcpResource,
            oauth: { clientId: "eval-client", clientSecret: "eval-secret" },
          },
        ],
      }),
      memory(),
    ],
    wrapFetch: (real) => async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== mcpEndpoint.origin) return real(input, init);
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const server = servers.get(token);
      return server ? server.fetch(request) : new Response("Unauthorized", { status: 401 });
    },
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
      const script = { queue: [] as ReturnType<typeof round>[] };
      scripts.set(`${caseId}#${repeat}`, script);
      // A Turn's call plays the next scripted round; an Auto-review gets a pass, and the Memory
      // pass after a Turn changes nothing.
      const rounds = Array.from({ length: 200 }, () => (options: TextOptions) => {
        if (isReviewCall(options)) return verdictRound(passVerdict);
        const isTurn = (options.tools ?? []).some((tool) => tool.name === "send_to_user");
        return isTurn ? (script.queue.shift() ?? round()) : round(text('{"ops": []}'));
      });
      adapters.set(key, createFakeAdapter({ rounds }).adapter);
      return { apiKey: key };
    },
  };

  /** Waits until Turn `turnId`'s Memory pass has ended, so its Notes are settled and usage booked. */
  async function passEnded(turnId: string, timeoutMs = 3 * 60_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const [row] = await db
        .select({ status: job.status })
        .from(job)
        .where(
          and(eq(job.name, "memory.bot-pass"), eq(job.idempotencyKey, `memory-pass:${turnId}`)),
        );
      if (row && row.status !== "queued" && row.status !== "running") return;
      // A Turn that ended queues its pass in the same transaction: a pass still missing is not coming.
      if (!row && Date.now() - started > 5_000) return;
      await sleep(250);
    }
  }

  /** The Turn that took Trigger `id`. */
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

  const stepRound = (step: Step) =>
    withUsage(round(toolCall({ name: step.name, input: step.input })), fakeUsage);

  async function runCase(evalCase: ProactiveCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const base = { caseId: evalCase.id, gating: evalCase.gating, repeat };
    const turns: TurnResult[] = [];
    try {
      const { userId, bot: made, found } = await freshBot(env, evalCase.id, repeat);
      const today = dayOf(new Date());
      const files = { notesPath: notesPath(made.id), today };
      if (evalCase.notes) {
        await computerOf(sdk, userId).writeFile(
          files.notesPath,
          evalCase.notes.replaceAll("{today}", today),
        );
      }
      // The user's Mail Connection: a token that never expires, served by this run's own server.
      const token = `eval-${evalCase.id}-${repeat}-${randomUUID()}`;
      const tools = mailTools("");
      const server = createFakeMcpServer({ auth: anyToken, tools });
      servers.set(token, server);
      await saveTokens(sdk, userId, mailServer.key, {
        accessToken: token,
        tokenType: "Bearer",
        scope: "read write",
      });

      // The Routine row of each kind, made when a Turn needs it, by an earlier Turn of the Bot's:
      // so a Routine's run isn't the Bot's first Turn, which the first Connection's note is for.
      const routineIds = new Map<"watch" | "brief", string>();
      let seedTurnId: string | undefined;
      async function routineOf(kind: "watch" | "brief") {
        const known = routineIds.get(kind);
        if (known) return known;
        if (!seedTurnId) {
          const [seedTurn] = await db
            .insert(botTurn)
            .values({
              id: uuidv7(),
              botId: made.id,
              conversationId: found!.conversationId,
              status: "complete",
              startedAt: new Date(Date.now() - 60_000),
              endedAt: new Date(Date.now() - 59_000),
              input: [],
              transcript: [],
            })
            .returning({ id: botTurn.id });
          seedTurnId = seedTurn!.id;
        }
        const id = uuidv7();
        const now = new Date();
        await db.insert(botRoutine).values({
          id,
          botId: made.id,
          name: kind === "watch" ? "check-my-apps" : "morning-brief",
          prompt: kind === "watch" ? defaultRoutinePrompts.watch : defaultRoutinePrompts.brief,
          schedule: {
            days: weekdays as never,
            times: kind === "watch" ? watchTimes : ["08:00"],
          },
          timeZone: defaultTimeZone,
          state: "active",
          readOnly: kind === "watch",
          createdByTurnId: seedTurnId,
          approvedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        routineIds.set(kind, id);
        return id;
      }

      for (const turn of evalCase.turns) {
        // What this Turn's Connection holds.
        tools[0]!.result = turn.inbox;
        const steps = (broken ? turn.broken : turn.good)(files);
        if (fake)
          scripts.get(`${evalCase.id}#${repeat}`)!.queue = [
            ...steps.map(stepRound),
            withUsage(round(), fakeUsage),
          ];

        let turnId: string;
        if (turn.start.kind === "user") {
          const triggerId = uuidv7();
          for await (const _ of await sendAndFollow(sdk, {
            userId,
            botId: made.id,
            id: triggerId,
            text: turn.start.message,
          })) {
            // Drained: the stream ends when the Turn does.
          }
          turnId = await turnTaking(triggerId);
        } else {
          const kind = turn.start.kind;
          const routineId = await routineOf(kind);
          const now = new Date();
          const taken = await db.transaction(async (tx) => {
            await lockConversation(tx, found!.conversationId);
            return receive(sdk, tx, {
              id: `${fireKeyPrefix(routineId)}${now.toISOString()}`,
              botId: found!.id,
              conversationId: found!.conversationId,
              source: "routine",
              channel: "schedule",
              text: routineSnapshot({
                name: kind === "watch" ? "check-my-apps" : "morning-brief",
                prompt:
                  kind === "watch" ? defaultRoutinePrompts.watch : defaultRoutinePrompts.brief,
                slot: now,
                timeZone: defaultTimeZone,
                lastRanAt: kind === "watch" ? new Date(now.getTime() - 3 * 60 * 60_000) : null,
              }),
              receivedAt: now,
            });
          });
          turnId = turnIdOf(taken);
          sdk.runner.wake();
        }
        const ended = await waitForTurn(env, turnId, 5 * 60_000);
        await passEnded(turnId);
        const calls = toolCallsOf(ended.transcript);
        const routines =
          turn.expect.kind === "offers"
            ? await db
                .select({
                  name: botRoutine.name,
                  state: botRoutine.state,
                  readOnly: botRoutine.readOnly,
                  schedule: botRoutine.schedule,
                })
                .from(botRoutine)
                .where(eq(botRoutine.botId, made.id))
                .orderBy(asc(botRoutine.name))
            : undefined;
        const rows = await db
          .select({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            costMicros: usage.costMicros,
          })
          .from(usage)
          .where(and(eq(usage.userId, userId), eq(usage.sourceId, turnId)));
        const cost = costOf(rows, prices);
        const score = scoreProactive(
          turn.expect,
          { status: ended.status, calls, routines },
          { watch: turn.start.kind === "watch" },
        );
        if (turn.start.kind === "watch" && cost.rows === 0) {
          score.reasons.push("the Watch run left no usage rows to price");
          score.passed = false;
        }
        turns.push({
          start: turn.start.kind,
          expected: turn.expect,
          score,
          toolCalls: calls,
          cost,
        });
      }
      const reasons = turns.flatMap((turn, index) =>
        turn.score.reasons.map((reason) =>
          turns.length > 1 ? `turn ${index + 1} (${turn.start}): ${reason}` : reason,
        ),
      );
      return {
        ...base,
        score: { passed: reasons.length === 0, reasons },
        turns,
        ms: Date.now() - started,
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      return {
        ...base,
        score: { passed: false, reasons: [`error: ${error}`] },
        turns,
        ms: Date.now() - started,
        error,
      };
    }
  }

  const chosen = proactiveCases.filter((evalCase) => !only || evalCase.id === only);
  const cases = limit === undefined ? chosen : chosen.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Proactive eval${fake ? (broken ? " (fake adapter, BROKEN scripts)" : " (fake adapter)") : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
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
  const tally = tallyProactive(results);
  console.log(`\nGating: ${tally.gating.passed}/${tally.gating.total} passed.`);

  // The Watch's cost, from the usage rows of its runs (spec #1024: replaces the $0.13-0.19 estimate).
  const watchRuns = results.flatMap((result) =>
    result.turns.filter((turn) => turn.start === "watch").map((turn) => turn.cost),
  );
  const mean = (pick: (cost: Cost) => number) =>
    watchRuns.length === 0
      ? 0
      : watchRuns.reduce((total, cost) => total + pick(cost), 0) / watchRuns.length;
  const watchCost = {
    runs: watchRuns.length,
    meanRecordedUsd: mean((cost) => cost.recordedUsd),
    meanListUsd: mean((cost) => cost.listUsd),
    meanInputTokens: mean((cost) => cost.inputTokens),
    meanOutputTokens: mean((cost) => cost.outputTokens),
    meanCacheReadTokens: mean((cost) => cost.cacheReadTokens),
    maxListUsd: Math.max(0, ...watchRuns.map((cost) => cost.listUsd)),
    prices,
  };
  console.log(
    `Watch cost over ${watchCost.runs} runs: $${watchCost.meanListUsd.toFixed(4)} each at list ` +
      `prices (max $${watchCost.maxListUsd.toFixed(4)}; ${Math.round(watchCost.meanInputTokens)} input ` +
      `tokens, ${Math.round(watchCost.meanCacheReadTokens)} of them cached, ` +
      `${Math.round(watchCost.meanOutputTokens)} output); the rows record ` +
      `$${watchCost.meanRecordedUsd.toFixed(4)} each (0 on a user's own key or plan).`,
  );

  // The broken scripts must all fail. A run that errored is not a failed score, so it doesn't count,
  // nor does one caught only because its Turn broke.
  const caught = results.filter(
    (result) =>
      !result.score.passed &&
      !result.error &&
      !result.score.reasons.some((reason) => reason.includes("usage rows")) &&
      result.score.reasons.some((reason) => !reason.includes("the Turn ended")),
  ).length;
  if (broken)
    console.log(`Broken scripts caught: ${caught}/${results.length} (all must be caught).`);

  await mkdir(resultsDir, { recursive: true });
  const file = join(
    resultsDir,
    `proactive-${broken ? "broken-" : ""}${startedAt.replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(
    file,
    JSON.stringify(
      { startedAt, fake, broken, model, repeats, tally, watchCost, runs: results },
      (_key, value) => (value instanceof RegExp ? String(value) : value),
      2,
    ),
  );
  console.log(`\nEvery run (tool calls, scores, cost) is in ${file}`);
  await jobs.stop();
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  const ok = broken
    ? caught === results.length
    : results.every((result) => !result.gating || result.score.passed);
  process.exit(ok ? 0 : 1);
}

await main();
