// The Rooms eval (spec #1055, ticket #1063): real Turns on a real Model, through the real `bot`
// plugin. Each case is a fresh user with a Room of three Bots and one Message to it; the run waits
// until the whole chain it sets off has ended, then scores who the work was handed to, who stayed
// quiet, and whether the chain ended. Run it with `pnpm -F @ai-chat/evals eval:rooms`; see
// src/rooms/README.md.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter, which plays each
// Bot's `good` script (found by the name its Room prompt gives it), for checking the harness and the
// scorers with no Model or key. With `--broken` it plays the `broken` scripts and every case must
// then FAIL: that is how a case is seen to fail before it is trusted. `--limit=<n>` runs the first
// n cases; `--case=<id>` only that case.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { user as userTable } from "@ai-chat/db/schema/auth";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { TextOptions } from "@tanstack/ai";

import { bot, botTrigger, botTurn } from "@botsdk/bot/storage";
import { createBot, createRoom } from "@botsdk/bot/bot/conversation";
import { sendToRoom } from "@botsdk/bot/bot/turn";
import { saveCredentials } from "@botsdk/bot/models/internal";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { isReviewCall, passVerdict, verdictRound } from "@botsdk/testing/fake-reviewer";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { fail, keyFor } from "../turn/judge-model";
import { toolCallsOf } from "../turn/routine-score";
import { type RoomsCase, roomsCases } from "./cases";
import {
  type Call,
  type Expect,
  type MemberObserved,
  type Observed,
  type Score,
  scoreRooms,
  sentTexts,
  tallyRooms,
} from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Bots' Model unless told otherwise: the step's default on OpenRouter. */
const defaultModel = "openrouter:anthropic/claude-sonnet-5.5";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The name a Room Turn's system prompt gives its Bot ("Its members: ... You are Forge."). */
function botNameOf(options: TextOptions): string | undefined {
  const text = ((options.systemPrompts ?? []) as unknown[])
    .map((prompt) =>
      typeof prompt === "object" && prompt !== null
        ? String((prompt as { content?: unknown }).content ?? "")
        : String(prompt),
    )
    .join("\n");
  return /Its members: [^\n]*?\. You are ([^\n]+?)\.(?:\n|$)/.exec(text)?.[1];
}

type RunResult = {
  caseId: string;
  gating: boolean;
  repeat: number;
  expected: Expect;
  score: Score;
  observed?: Observed;
  /** Every tool call each member's Turns made, in order. */
  toolCalls: Record<string, Call[]>;
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
  if (only && !roomsCases.some((evalCase) => evalCase.id === only)) {
    fail(`--case must be one of ${roomsCases.map((evalCase) => evalCase.id).join(", ")}`);
  }
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (src/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  /** The fake Model's script queue per Bot name, by the run's API key. */
  const scripts = new Map<string, Map<string, ReturnType<typeof round>[]>>();
  const adapters = new Map<string, ReturnType<typeof createFakeAdapter>["adapter"]>();
  const sdk = createComputerSdk({
    db,
    provider: fakeComputerProvider().provider,
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

  /** The Credentials a run's user saves, and (fake) the adapter that plays that run's scripts. */
  function credentialsFor(evalCase: RoomsCase, repeat: number) {
    if (!fake) return apiKey === null ? null : { apiKey };
    const key = `fake-${evalCase.id}-${repeat}-${randomUUID()}`;
    const queues = new Map<string, ReturnType<typeof round>[]>();
    for (const [name, steps] of Object.entries(broken ? evalCase.broken : evalCase.good)) {
      queues.set(
        name,
        steps.map((step) => round(toolCall({ name: step.name, input: step.input }))),
      );
    }
    scripts.set(key, queues);
    // A Turn's call plays its Bot's next scripted round, then quiet ones; an Auto-review gets a pass.
    const rounds = Array.from({ length: 400 }, () => (options: TextOptions) => {
      if (isReviewCall(options)) return verdictRound(passVerdict);
      const name = botNameOf(options);
      const isTurn = (options.tools ?? []).some((tool) => tool.name === "send_to_user");
      // A Turn whose prompt names no Bot would play nothing, and pass or fail for the wrong reason.
      if (isTurn && !name) throw new Error('The Room prompt no longer says "You are <name>."');
      return (name && queues.get(name)?.shift()) || round();
    });
    adapters.set(key, createFakeAdapter({ rounds }).adapter);
    return { apiKey: key };
  }

  /**
   * Waits until the chain has ended: every Trigger in the Room has a Turn that ended or is skipped,
   * and that held on three reads in a row (a Turn queues its handoffs before it ends).
   */
  async function settled(conversationId: string, timeoutMs = 10 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    let quiet = 0;
    while (Date.now() < deadline) {
      const triggers = await db
        .select({ turnId: botTrigger.turnId, skippedAt: botTrigger.skippedAt })
        .from(botTrigger)
        .where(eq(botTrigger.conversationId, conversationId));
      const turnIds = triggers.flatMap((t) => (t.turnId ? [t.turnId] : []));
      const turns = turnIds.length
        ? await db
            .select({ status: botTurn.status })
            .from(botTurn)
            .where(inArray(botTurn.id, turnIds))
        : [];
      const open =
        triggers.some((t) => !t.turnId && !t.skippedAt) ||
        turns.some((t) => t.status === "running");
      quiet = open || triggers.length === 0 ? 0 : quiet + 1;
      if (quiet >= 3) return;
      await sleep(500);
    }
    throw new Error("The Room's chain did not end");
  }

  async function runCase(evalCase: RoomsCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const base = {
      caseId: evalCase.id,
      gating: evalCase.gating,
      repeat,
      expected: evalCase.expect,
    };
    try {
      const userId = randomUUID();
      await db
        .insert(userTable)
        .values({ id: userId, name: "Eval", email: `${userId}@eval.invalid` });
      const fields = credentialsFor(evalCase, repeat);
      if (fields) {
        await saveCredentials(sdk, userId, {
          service: model.split(":")[0]!,
          fields,
          hint: "eval",
          verified: true,
        });
      }
      const made = [];
      for (const name of evalCase.members) {
        made.push(await createBot(db, userId, { name, model }, new Date()));
      }
      const room = await createRoom(
        db,
        userId,
        { name: "Eval room", botIds: made.map((b) => b.id) },
        new Date(),
      );
      await sendToRoom(sdk, {
        userId,
        conversationId: room.conversationId,
        text: evalCase.message,
      });
      await settled(room.conversationId);

      const turns = await db
        .select({
          botId: botTurn.botId,
          name: bot.name,
          status: botTurn.status,
          transcript: botTurn.transcript,
          endedAt: botTurn.endedAt,
        })
        .from(botTurn)
        .innerJoin(bot, eq(bot.id, botTurn.botId))
        .where(eq(botTurn.conversationId, room.conversationId))
        .orderBy(asc(botTurn.startedAt));
      const toolCalls: Record<string, Call[]> = {};
      const members: MemberObserved[] = evalCase.members.map((name) => {
        const own = turns.filter((turn) => turn.name === name);
        const calls = own.flatMap((turn) => toolCallsOf(turn.transcript));
        toolCalls[name] = calls;
        return {
          name,
          turns: own.length,
          allComplete: own.every((turn) => turn.status === "complete"),
          messages: own.flatMap((turn) => sentTexts(toolCallsOf(turn.transcript))),
        };
      });
      // The last Message sent: the one from the Turn that ended last among those that sent any.
      const sending = turns
        .filter((turn) => sentTexts(toolCallsOf(turn.transcript)).length > 0)
        .sort((a, b) => (a.endedAt?.getTime() ?? 0) - (b.endedAt?.getTime() ?? 0));
      const lastTurn = sending.at(-1);
      const lastTexts = lastTurn ? sentTexts(toolCallsOf(lastTurn.transcript)) : [];
      const agent = await db
        .select({ hops: botTrigger.hops, skipReason: botTrigger.skipReason })
        .from(botTrigger)
        .where(
          and(eq(botTrigger.conversationId, room.conversationId), eq(botTrigger.source, "agent")),
        );
      const observed: Observed = {
        members,
        agentTriggers: agent.length,
        maxHops: Math.max(0, ...agent.map((trigger) => trigger.hops)),
        hopLimitSkips: agent.filter((trigger) => trigger.skipReason === "hop_limit").length,
        last:
          lastTurn && lastTexts.length > 0
            ? { name: lastTurn.name, text: lastTexts.at(-1)! }
            : undefined,
      };
      return {
        ...base,
        score: scoreRooms(evalCase.expect, observed),
        observed,
        toolCalls,
        ms: Date.now() - started,
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      return {
        ...base,
        score: { passed: false, reasons: [`error: ${error}`] },
        toolCalls: {},
        ms: Date.now() - started,
        error,
      };
    }
  }

  const chosen = roomsCases.filter((evalCase) => !only || evalCase.id === only);
  const cases = limit === undefined ? chosen : chosen.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Rooms eval${fake ? (broken ? " (fake adapter, BROKEN scripts)" : " (fake adapter)") : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
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
    console.log(`${evalCase.id.padEnd(16)} ${passed}/${own.length} passed`);
  }
  const tally = tallyRooms(results);
  console.log(`\nGating: ${tally.gating.passed}/${tally.gating.total} passed.`);

  // The broken scripts must all fail. A run that errored is not a failed score, so it doesn't count.
  const caught = results.filter((result) => !result.score.passed && !result.error).length;
  if (broken)
    console.log(`Broken scripts caught: ${caught}/${results.length} (all must be caught).`);

  await mkdir(resultsDir, { recursive: true });
  const file = join(
    resultsDir,
    `rooms-${broken ? "broken-" : ""}${startedAt.replace(/[:.]/g, "-")}.json`,
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
