import { sendAndFollow } from "../../test/support/follow-send";
// The Computer tool-use eval (spec #519, "Evals"): scores whether a real Model uses `shell` and the
// file tools when a task needs them, and leaves the Computer alone in plain chat. Every run is a real
// Turn through the `bot` plugin on a real Computer (local E2B). Run it with
// `pnpm -F @ai-chat/bot-sdk eval:computer`; see eval/computer/README.md.
//
// `--fake` (or EVAL_FAKE=1) plays each case's scripted calls instead of a Model, for checking the
// script and the Computer without a key. `--limit=<n>` runs the first n cases.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { botTurn, computer as computerTable } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { computerOf } from "@botsdk/bot/bot/agent-loop";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import { createFakeAdapter, round, toolCall } from "../../test/support/fake-adapter";
import { desc, eq } from "drizzle-orm";
import { freshBot, seedHistory } from "../turn/case";
import { type ComputerCase, computerCases } from "./cases";
import { type Observed, observeTools, scoreComputerRun, tallyComputer } from "./score";
import {
  createComputerSdk,
  databaseUrlFromEnv,
  defaultTemplate,
  fail,
  localE2bProvider,
  prepareSchema,
} from "./setup";
import { botDirectory } from "@botsdk/bot/bot/conversation";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The API key variable of each Provider the eval may use. */
const keyVariables: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const percent = (rate: number | null) =>
  rate === null ? "   n/a" : `${(rate * 100).toFixed(1).padStart(5)}%`;

/** What the fake Model plays for a case: its tool calls, one per model call, then the reply. */
function fakeScript(evalCase: ComputerCase) {
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

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  const repeats = Number(process.env.EVAL_REPEATS ?? 3);
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["--limit", limit ?? 1],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  const model = fake
    ? (process.env.EVAL_BOT_MODEL ?? "openai:gpt-5.4-mini")
    : process.env.EVAL_BOT_MODEL;
  if (!model) fail("EVAL_BOT_MODEL is not set. See packages/bot-sdk/eval/computer/README.md.");
  const provider = model.split(":")[0]!;
  const apiKey = fake ? "sk-fake" : process.env[keyVariables[provider] ?? ""];
  if (!apiKey) fail(`${keyVariables[provider] ?? `A key for ${provider}`} is not set`);

  const db = await prepareSchema(databaseUrlFromEnv());
  const computerProvider = localE2bProvider(process.env.EVAL_TEMPLATE ?? defaultTemplate);
  /** The fake Model's case for each run, found by the run's own API key. */
  const scripts = new Map<string, ComputerCase>();
  const sdk = createComputerSdk({
    db,
    provider: computerProvider,
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
  const jobs = runnerJobs(sdk);
  await jobs.start();

  const cases = limit === undefined ? computerCases : computerCases.slice(0, limit);
  const startedAt = new Date().toISOString();
  console.log(
    `Computer tool-use eval${fake ? " (fake adapter)" : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
  );

  const runs = [];
  let done = 0;
  // One at a time: the local E2B fits one sandbox, and each run has a fresh user and Computer.
  for (const evalCase of cases) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const started = Date.now();
      const sent: string[] = [];
      let tools: string[] = [];
      let error: string | undefined;
      let reasons: string[];
      let passed: boolean;
      let userId: string | undefined;
      try {
        const credentialKey = fake ? `fake-${evalCase.id}-${repeat}-${randomUUID()}` : apiKey;
        if (fake) scripts.set(credentialKey, evalCase);
        const fresh = await freshBot(
          { db, sdk, model, credentialsFor: () => ({ apiKey: credentialKey }) },
          evalCase.id,
          repeat,
        );
        userId = fresh.userId;
        const botId = fresh.bot.id;
        await seedHistory(
          db,
          { botId, conversationId: fresh.found!.conversationId },
          evalCase.history,
        );
        const computer = computerOf(sdk, userId);
        const inBot = (path: string) => `${botDirectory(botId)}/${path}`;
        for (const file of evalCase.seed ?? []) {
          await computer.writeFile(inBot(file.path), file.content);
        }

        let status: Observed["status"] = "stopped";
        for await (const event of await sendAndFollow(sdk, {
          userId,
          botId,
          id: uuidv7(),
          text: evalCase.message,
        })) {
          if (event.type === "message" && event.message.role === "assistant") {
            sent.push(event.message.text);
          }
          if (event.type === "turnEnded") status = event.status;
        }
        const [turn] = await db
          .select({ transcript: botTurn.transcript, error: botTurn.error })
          .from(botTurn)
          .where(eq(botTurn.botId, botId))
          .orderBy(desc(botTurn.startedAt))
          .limit(1);
        tools = observeTools(turn?.transcript);
        const problems = await (evalCase.check?.({
          sent,
          file: async (path) => {
            const bytes = await computer.readFile(inBot(path));
            return bytes ? new TextDecoder().decode(bytes) : null;
          },
        }) ?? []);
        ({ passed, reasons } = scoreComputerRun(evalCase.expected, {
          status,
          error: turn?.error,
          tools,
          problems,
        }));
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        passed = false;
        reasons = [`error: ${error}`];
      } finally {
        if (userId) await dropComputer(userId);
      }
      done += 1;
      console.log(
        `  [${done}/${cases.length * repeats}] ${evalCase.id} #${repeat}: ${passed ? "pass" : "FAIL"} (tools: ${tools.join(", ") || "none"})`,
      );
      for (const reason of reasons) console.log(`      ${reason}`);
      runs.push({
        caseId: evalCase.id,
        repeat,
        expected: evalCase.expected,
        passed,
        reasons,
        tools,
        sent,
        ms: Date.now() - started,
        error,
      });
    }
  }

  /** Kills the user's sandbox and removes the row, so no sleep check finds a dead Computer. */
  async function dropComputer(userId: string) {
    const [row] = await db.select().from(computerTable).where(eq(computerTable.userId, userId));
    if (row?.sandboxId) await computerProvider.kill(row.sandboxId).catch(() => {});
    await db.delete(computerTable).where(eq(computerTable.userId, userId));
  }

  await jobs.stop();
  const rates = tallyComputer(runs);
  console.log("");
  for (const [id, r] of Object.entries(rates.cases)) {
    console.log(
      `${id.padEnd(20)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} ${percent(r.rate)}`,
    );
  }
  for (const group of ["use", "none"] as const) {
    const r = rates[group];
    console.log(
      `${`all ${group}`.padEnd(20)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} ${percent(r.rate)}`,
    );
  }

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `computer-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ startedAt, fake, model, repeats, rates, runs }, null, 2));
  console.log(`\nEvery run is in ${file}`);
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  // A run that errored (a bad key, a Computer that would not start) is not a Model failure: exit non-zero.
  process.exit(runs.some((run) => run.error) ? 1 : 0);
}

await main();
