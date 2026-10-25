import { sendAndFollow } from "../../test/support/follow-send";
// The Bot memory eval (spec #624, #633): scores a Bot's file memory (ADR 0022) with real Models. Each
// case is a fresh user with Bots on the fake Computer disk; Turns go through the real `bot` plugin,
// each Turn's post-turn pass runs on the Bot's own Model, and the memory files are then scored.
// Run it with `pnpm -F @ai-chat/bot-sdk eval:bot-memory`; see eval/memory/README.md.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter, which plays what
// a good Bot and pass would do, for checking the script without any Model or key.
// `--limit=<n>` runs the first n cases.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { user as userTable } from "@ai-chat/db/schema/auth";
import { and, asc, eq } from "drizzle-orm";

import { botTurn } from "../../core/server/db/schema";
import type { Database } from "../../core/server/db/index";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { computerOf } from "../../plugins/bot/server/computer-tools";
import { createBot } from "../../plugins/bot/server/store";
import { sendToUserToolName } from "../../plugins/bot/server/tool-names";
import type { ComputerHandle } from "../../plugins/computer/server/plugin";
import { dayOf, memoryDirectory } from "../../plugins/memory/server/bot-memory";
import { memory } from "../../plugins/memory/server/feature";
import { saveCredentials } from "../../plugins/models/server/credentials/store";
import { job } from "../../plugins/runner/server/db/job";
import { runnerJobs } from "../../plugins/runner/server/plugin";
import { createFakeAdapter, round, text, toolCall } from "../../test/support/fake-adapter";
import { fakeComputerProvider } from "../../test/plugins/computer/server/fake-provider";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { fail, judgeCompletion, keyFor } from "../turn/judge-model";
import { type Ask, botMemoryCases, type BotMemoryCase, type Files, tallyCases } from "./bot-cases";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Model both the Bots and the judge use unless told otherwise: the step's default on OpenRouter. */
const defaultModel = "openrouter:anthropic/claude-sonnet-5.5";

/** How long a Turn's pass may take to end, in real mode. */
const passTimeoutMs = 3 * 60_000;

type RunResult = {
  caseId: string;
  repeat: number;
  passed: boolean;
  problems: string[];
  /** The Messages each Turn sent. */
  sent: string[][];
  /** What each pass changed, per Turn. */
  changes: unknown[][];
  /** Each Bot's memory files at the end. */
  files: Files[];
  ms: number;
  error?: string;
};

const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : undefined);

/** A Bot's memory files by path under its memory directory: profile, notes and each Log month. */
async function readFiles(computer: ComputerHandle, botId: string): Promise<Files> {
  const directory = memoryDirectory(botId);
  const files: Files = {};
  const read = async (path: string) => {
    const content = decode(await computer.readFile(`${directory}/${path}`));
    if (content !== undefined) files[path] = content;
  };
  await read("profile.md");
  await read("notes.md");
  for (const entry of (await computer.list(`${directory}/log`)) ?? []) {
    if (entry.kind === "file") await read(`log/${entry.name}`);
  }
  return files;
}

/** Waits until Turn `turnId`'s memory pass has ended; returns an error text when it failed or never came. */
async function passEnded(db: Database, turnId: string): Promise<string | null> {
  const key = `memory-pass:${turnId}`;
  const started = Date.now();
  while (Date.now() - started < passTimeoutMs) {
    const [row] = await db
      .select({ status: job.status, lastError: job.lastError })
      .from(job)
      .where(and(eq(job.name, "memory.bot-pass"), eq(job.idempotencyKey, key)));
    if (row?.status === "succeeded") return null;
    if (row?.status === "failed" || row?.status === "cancelled") {
      return `the pass ${row.status}: ${row.lastError ?? "no error"}`;
    }
    // A Turn that ended queues its pass in the same transaction, so a missing row stays missing.
    if (!row && Date.now() - started > 5_000) return "no pass was queued";
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return "the pass did not end in time";
}

const percent = (passed: number, total: number) =>
  total === 0 ? "n/a" : `${((passed / total) * 100).toFixed(0)}%`;

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  const repeats = Number(process.env.EVAL_REPEATS ?? 1);
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["EVAL_CONCURRENCY", concurrency],
    ["--limit", limit ?? 1],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  const judgeModel = process.env.EVAL_JUDGE_MODEL ?? model;
  // `null`: the Model runs on the owner's ChatGPT plan (eval/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const botKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const judgeKey = fake ? "sk-fake" : keyFor(judgeModel, plan, " (the judge)");
  const databaseUrl = databaseUrlFromEnv();

  const complete = fake ? null : judgeCompletion(judgeModel, judgeKey, plan);
  const ask: Ask = async (claim, lines, fakeAnswer) => {
    if (lines.length === 0) return false;
    if (!complete) return lines.some((line) => fakeAnswer.test(line));
    const reply = await complete(
      "You check memory lines and replies against a claim.\n\n" +
        `Texts:\n${lines.map((line) => `- ${line}`).join("\n")}\n\n` +
        `Is it true that at least one of the texts above ${claim}? ` +
        "Answer yes or no only.",
    );
    return /^\W*yes\b/i.test(reply.trim());
  };

  const db = await prepareSchema(databaseUrl);
  const computerFake = fakeComputerProvider();
  /** The fake Model, one adapter per run (found by its API key), playing its rounds across calls. */
  const adapters = new Map<string, ReturnType<typeof createFakeAdapter>["adapter"]>();
  const sdk = createComputerSdk({
    db,
    provider: computerFake.provider,
    features: [memory()],
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

  const today = dayOf(new Date());

  async function runCase(evalCase: BotMemoryCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const sent: string[][] = [];
    const changes: unknown[][] = [];
    let files: Files[] = [];
    try {
      const userId = randomUUID();
      await db
        .insert(userTable)
        .values({ id: userId, name: "Eval", email: `${userId}@eval.invalid` });
      const fakeKey = `fake-${evalCase.id}-${repeat}-${randomUUID()}`;
      const apiKey = fake ? fakeKey : botKey;
      if (fake) {
        adapters.set(
          fakeKey,
          createFakeAdapter({
            rounds: evalCase.fake.flatMap((turn) => [
              round(
                toolCall({
                  name: sendToUserToolName,
                  input: { text: turn.reply, endTurn: true },
                }),
              ),
              round(text(JSON.stringify({ ops: turn.ops }))),
            ]),
          }).adapter,
        );
      }
      // A stored OpenAI key would come before the linked plan, so a plan run stores none.
      if (apiKey !== null) {
        await saveCredentials(sdk, userId, {
          service: model.split(":")[0]!,
          fields: { apiKey },
          hint: "eval",
          verified: true,
        });
      }
      const botIds: string[] = [];
      for (const name of evalCase.bots) {
        botIds.push((await createBot(db, userId, { name, model }, new Date())).id);
        // The Bots are ordered by creation time, so a millisecond apart.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const computer = computerOf(sdk, userId);
      const seeded = evalCase.seed?.(today) ?? [];
      for (const [index, seed] of seeded.entries()) {
        for (const [path, content] of Object.entries(seed)) {
          await computer.writeFile(`${memoryDirectory(botIds[index]!)}/${path}`, content);
        }
      }

      for (const turn of evalCase.turns) {
        const botId = botIds[turn.bot]!;
        const messages: string[] = [];
        for await (const event of await sendAndFollow(sdk, {
          userId,
          botId,
          id: uuidv7(),
          text: turn.message,
        })) {
          if (event.type === "message" && event.message.role === "assistant") {
            messages.push(event.message.text);
          }
        }
        sent.push(messages);
        const turnRows = await db
          .select({ id: botTurn.id, error: botTurn.error })
          .from(botTurn)
          .where(eq(botTurn.botId, botId))
          .orderBy(asc(botTurn.startedAt));
        const latest = turnRows.at(-1);
        if (!latest) throw new Error("The Turn left no row");
        if (latest.error) throw new Error(`the Turn failed: ${latest.error}`);
        const passError = await passEnded(db, latest.id);
        if (passError) throw new Error(passError);
        const [after] = await db
          .select({ memoryChanges: botTurn.memoryChanges })
          .from(botTurn)
          .where(eq(botTurn.id, latest.id));
        changes.push(after?.memoryChanges ?? []);
      }

      files = await Promise.all(botIds.map((botId) => readFiles(computer, botId)));
      const problems = await evalCase.check({ sent, files, ask }, today);
      return {
        caseId: evalCase.id,
        repeat,
        passed: problems.length === 0,
        problems,
        sent,
        changes,
        files,
        ms: Date.now() - started,
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      return {
        caseId: evalCase.id,
        repeat,
        passed: false,
        problems: [`error: ${error}`],
        sent,
        changes,
        files,
        ms: Date.now() - started,
        error,
      };
    }
  }

  const cases = limit === undefined ? botMemoryCases : botMemoryCases.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Bot memory eval${fake ? " (fake adapter)" : ""}: ${cases.length} cases x ${repeats} repeats, ` +
      `Model ${model}, judge ${judgeModel}`,
  );

  const results: RunResult[] = [];
  let next = 0;
  let done = 0;
  const lanes = Array.from({ length: Math.min(concurrency, runs.length) }, async () => {
    while (next < runs.length) {
      const { evalCase, repeat } = runs[next++]!;
      const result = await runCase(evalCase, repeat);
      results.push(result);
      done += 1;
      console.log(
        `  [${done}/${runs.length}] ${evalCase.id} #${repeat}: ${result.passed ? "pass" : "FAIL"}`,
      );
      for (const problem of result.problems) console.log(`      ${problem}`);
    }
  });
  await Promise.all(lanes);

  console.log("");
  for (const evalCase of cases) {
    const own = results.filter((result) => result.caseId === evalCase.id);
    const { passed, total } = tallyCases(own);
    console.log(
      `${evalCase.id.padEnd(28)} ${String(passed).padStart(2)}/${String(total).padEnd(2)} ${percent(passed, total).padStart(5)}  ${evalCase.summary}`,
    );
  }
  const overall = tallyCases(results);
  console.log(
    `${"overall".padEnd(28)} ${String(overall.passed).padStart(2)}/${String(overall.total).padEnd(2)} ${percent(overall.passed, overall.total).padStart(5)}`,
  );

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `bot-memory-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify(
      { startedAt, fake, model, judgeModel, repeats, overall, runs: results },
      null,
      2,
    ),
  );
  console.log(`\nEvery run (replies, pass changes, memory files) is in ${file}`);
  await jobs.stop();
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  process.exit(overall.passed === overall.total ? 0 : 1);
}

await main();
