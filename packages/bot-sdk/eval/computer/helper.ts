// The Computer-use Helper eval (spec #587, #599): a real Model, as the Bot, hands a task to a
// Computer-use Helper, which drives a real Screen on a fixture site served inside the Computer
// (local E2B). It scores whether the Helper finds a fact through the Browser tools, and whether it
// stops at a login with `ask_user` without typing a password. Run it with
// `pnpm -F @ai-chat/bot-sdk eval:computer:helper` (`--case=<id>` runs one case); see eval/computer/README.md.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { asc, eq } from "drizzle-orm";

import { botHelper, botTurn, computer as computerTable } from "../../core/server/db/schema";
import { uuidv7 } from "../../core/server/lib/uuidv7";
import { computerOf } from "../../plugins/bot/server/computer-tools";
import { bot } from "../../plugins/bot/server/plugin";
import { sendToBot } from "../../plugins/bot/server/turn";
import { job as jobTable } from "../../plugins/runner/server/db/job";
import { runnerJobs } from "../../plugins/runner/server/plugin";
import { freshBot } from "../turn/case";
import { helperStarts } from "../turn/ladder-score";
import { helperCases } from "./helper-cases";
import { helperTools, scoreHelperRun, typedTexts } from "./helper-score";
import { loginAttempts, startFixture } from "./fixture";
import { tallyComputer } from "./score";
import {
  createComputerSdk,
  databaseUrlFromEnv,
  defaultTemplate,
  fail,
  localE2bProvider,
  prepareSchema,
} from "./setup";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The longest a Helper may take to finish or hand off before the run is scored without it. */
const helperDeadlineMs = 8 * 60_000;

/** The API key variable of each Provider the eval may use. */
const keyVariables: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const percent = (rate: number | null) =>
  rate === null ? "   n/a" : `${(rate * 100).toFixed(1).padStart(5)}%`;

async function main() {
  const repeats = Number(process.env.EVAL_REPEATS ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1)
    fail("EVAL_REPEATS must be a whole number, 1 or more");
  const only = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
  const cases = helperCases.filter((evalCase) => !only || evalCase.id === only);
  if (cases.length === 0) fail(`No case named ${only}`);
  const model = process.env.EVAL_BOT_MODEL;
  if (!model) fail("EVAL_BOT_MODEL is not set. See packages/bot-sdk/eval/computer/README.md.");
  const provider = model.split(":")[0]!;
  const apiKey = process.env[keyVariables[provider] ?? ""];
  if (!apiKey) fail(`${keyVariables[provider] ?? `A key for ${provider}`} is not set`);

  const db = await prepareSchema(databaseUrlFromEnv());
  const computerProvider = localE2bProvider(process.env.EVAL_TEMPLATE ?? defaultTemplate);
  // Jobs a past run left (a Bot's follow-up Turn, a sleep check) would wake Computers of old users.
  await db.delete(jobTable);

  const startedAt = new Date().toISOString();
  console.log(
    `Computer-use Helper eval: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
  );

  const runs = [];
  let done = 0;
  // One at a time: the local E2B fits one sandbox, and each run has a fresh user and Computer.
  for (const evalCase of cases) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const started = Date.now();
      let reasons: string[];
      let passed: boolean;
      let userId: string | undefined;
      let observed: Record<string, unknown> = {};
      // Its own SDK and runner per run, stopped before the Computer is dropped: the Helper's report
      // starts a follow-up Turn that would otherwise wake the dropped Computer.
      const sdk = createComputerSdk({ db, provider: computerProvider, more: [bot()] });
      const jobs = runnerJobs(sdk);
      await jobs.start();
      try {
        const fresh = await freshBot(
          { db, sdk, model, credentialsFor: () => ({ apiKey }) },
          evalCase.id,
          repeat,
        );
        userId = fresh.userId;
        const botId = fresh.bot.id;
        const computer = computerOf(sdk, userId);
        await startFixture(computer);

        const turnId = uuidv7();
        for await (const _ of await sendToBot(sdk, {
          userId,
          botId,
          id: turnId,
          text: evalCase.message,
        })) {
          // Drained: the stream ends when the Turn does.
        }
        const [turn] = await db
          .select({ transcript: botTurn.transcript })
          .from(botTurn)
          .where(eq(botTurn.botId, botId))
          .orderBy(asc(botTurn.startedAt))
          .limit(1);
        const starts = helperStarts(turn?.transcript);

        // The Helper runs on its own job: wait until it ends or hands the Screen to the user.
        const deadline = Date.now() + helperDeadlineMs;
        let helper = (await helpersOf(botId))[0];
        while (helper && helper.status === "running" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          helper = (await helpersOf(botId))[0];
        }
        observed = {
          helperTypes: starts.map((start) => start.type),
          status: helper?.status ?? null,
          report: helper?.report ?? null,
          tools: helperTools(helper?.transcript),
          typed: typedTexts(helper?.transcript),
          loginAttempts: await loginAttempts(computer),
        };
        ({ passed, reasons } = scoreHelperRun(
          evalCase.expect,
          observed as Parameters<typeof scoreHelperRun>[1],
        ));
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : String(caught);
        passed = false;
        reasons = [`error: ${error}`];
        observed = { error };
      } finally {
        await jobs.stop();
        await db.delete(jobTable);
        if (userId) await dropComputer(userId);
      }
      done += 1;
      console.log(
        `  [${done}/${cases.length * repeats}] ${evalCase.id} #${repeat}: ${passed ? "pass" : "FAIL"} (${Math.round((Date.now() - started) / 1000)} s)`,
      );
      for (const reason of reasons) console.log(`      ${reason}`);
      runs.push({
        caseId: evalCase.id,
        repeat,
        expected: evalCase.expect.kind === "report" ? "use" : "none",
        passed,
        reasons,
        observed,
        ms: Date.now() - started,
      });
    }
  }

  function helpersOf(botId: string) {
    return db
      .select()
      .from(botHelper)
      .where(eq(botHelper.botId, botId))
      .orderBy(asc(botHelper.startedAt));
  }

  /** Kills the user's sandbox, and its Screens with it, and removes the row. */
  async function dropComputer(userId: string) {
    const [row] = await db.select().from(computerTable).where(eq(computerTable.userId, userId));
    if (row?.sandboxId) await computerProvider.kill(row.sandboxId).catch(() => {});
    await db.delete(computerTable).where(eq(computerTable.userId, userId));
  }

  const rates = tallyComputer(runs);
  console.log("");
  for (const [id, r] of Object.entries(rates.cases)) {
    console.log(
      `${id.padEnd(20)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} ${percent(r.rate)}`,
    );
  }

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `helper-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ startedAt, model, repeats, rates, runs }, null, 2));
  console.log(`\nEvery run is in ${file}`);
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  process.exit(runs.some((run) => run.observed && "error" in run.observed) ? 1 : 0);
}

await main();
