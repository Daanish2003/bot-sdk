import { sendAndFollow } from "@ai-chat/test-support/follow-send";
// The Skills eval (spec #713, ticket #721): real Turns on a real Model, through the real `bot` and
// `skills` plugins, on the SDK's fake Computer seeded with Skills. It scores when the Bot reads a Skill
// (Use), when it saves one (Save), and whether it follows and fixes the ones it has (Follow and fix).
// Run it with `pnpm -F @ai-chat/evals eval:skills`; see src/skills/README.md.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter, which plays each
// case's scripted tool calls, for checking the script without any Model or key.
// `--limit=<n>` runs the first n cases; `--group=use|save|follow-fix` only that group.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";

import { botTrigger } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { computerOf } from "@botsdk/bot/bot/agent-loop";
import { lockConversation, receive } from "@botsdk/bot/bot/triggers";
import { routineSnapshot, webhookPayloadLabel } from "@botsdk/bot/bot/routines";
import { defaultTimeZone } from "@botsdk/bot/bot/conversation";
import { sendToUserToolName } from "@botsdk/bot/bot/context";
import { skills } from "@botsdk/skills";
import { skillsDirectory } from "@botsdk/bot/bot/skill-files";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { createFakeAdapter, round, toolCall } from "@botsdk/testing/fake-adapter";
import { isReviewCall, passVerdict, verdictRound } from "@botsdk/testing/fake-reviewer";
import { fakeComputerProvider } from "@botsdk/testing/fake-computer-provider";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { fail, keyFor } from "../turn/judge-model";
import { freshBot, type TurnEnv } from "../turn/case";
import { turnIdOf, toolCallsOf } from "../turn/routine-score";
import { waitForTurn } from "../turn/routine-run";
import { sentTexts } from "../turn/score";
import { type SkillsCase, skillsCases } from "./cases";
import { type Expect, type Score, scoreSkills, useRates } from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Model the Bots use unless told otherwise: the step's default on OpenRouter. */
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
  group: SkillsCase["group"];
  repeat: number;
  expected: Expect;
  score: Score;
  sent: string[];
  toolCalls: { name: string; args: unknown }[];
  /** The Skills on the Computer after the Turn, by name. */
  skills: Record<string, string>;
  ms: number;
  error?: string;
};

const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);

async function main() {
  const fake = process.argv.includes("--fake") || process.env.EVAL_FAKE === "1";
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
  const group = process.argv.find((arg) => arg.startsWith("--group="))?.slice("--group=".length);
  const repeats = Number(process.env.EVAL_REPEATS ?? 1);
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 4);
  for (const [name, value] of [
    ["EVAL_REPEATS", repeats],
    ["EVAL_CONCURRENCY", concurrency],
    ["--limit", limit ?? 1],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) fail(`${name} must be a whole number, 1 or more`);
  }
  if (group && !["use", "save", "follow-fix"].includes(group)) {
    fail("--group must be use, save or follow-fix");
  }
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (src/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  // A shell command naming something a stale Skill points to fails, as on a Computer where it moved.
  const stale = [...new Set(skillsCases.flatMap((evalCase) => evalCase.stale ?? []))];
  const computerFake = fakeComputerProvider({
    onCommand: ({ command }) => {
      // Only a command that runs the path fails, not one that reads or edits the Skill naming it.
      const missing = command.includes("SKILL.md")
        ? undefined
        : stale.find((name) => command.includes(name));
      return missing
        ? {
            exitCode: 1,
            stdout: "",
            stderr: `bash: ${missing}: No such file or directory`,
          }
        : { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  /** The fake Model, one adapter per run (found by its API key), playing its rounds across calls. */
  const adapters = new Map<string, ReturnType<typeof createFakeAdapter>["adapter"]>();
  const sdk = createComputerSdk({
    db,
    provider: computerFake.provider,
    features: [skills()],
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
      const evalCase = skillsCases.find((c) => c.id === caseId)!;
      adapters.set(
        key,
        passingReviews(
          createFakeAdapter({
            rounds: [
              ...evalCase.fake.map((step) =>
                round(toolCall({ name: step.name, input: step.input })),
              ),
              round(
                toolCall({
                  name: sendToUserToolName,
                  input: { text: evalCase.reply, endTurn: true },
                }),
              ),
            ],
          }).adapter,
        ),
      );
      return { apiKey: key };
    },
  };

  async function runCase(evalCase: SkillsCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const base = { caseId: evalCase.id, group: evalCase.group, repeat, expected: evalCase.expect };
    let sent: string[] = [];
    let toolCalls: RunResult["toolCalls"] = [];
    let after: Record<string, string> = {};
    try {
      const { userId, bot: made, found } = await freshBot(env, evalCase.id, repeat);
      const computer = computerOf(sdk, userId);
      const directory = skillsDirectory(made.id);
      for (const [name, text] of Object.entries(evalCase.skills)) {
        await computer.writeFile(`${directory}/${name}/SKILL.md`, text);
      }
      for (const [path, content] of Object.entries(evalCase.files ?? {})) {
        await computer.writeFile(path, content);
      }

      const { start } = evalCase;
      let turnId: string;
      if (start.kind === "user") {
        // The Message's id is its Trigger's id; the Trigger names the Turn that took it.
        const id = uuidv7();
        for await (const _ of await sendAndFollow(sdk, {
          userId,
          botId: made.id,
          id,
          text: start.message,
        })) {
          // Drained: the stream ends when the Turn does.
        }
        const [trigger] = await db
          .select({ turnId: botTrigger.turnId })
          .from(botTrigger)
          .where(eq(botTrigger.id, id));
        if (!trigger?.turnId) throw new Error("No Turn took the user Message");
        turnId = trigger.turnId;
      } else {
        const now = new Date();
        const snapshot = routineSnapshot({
          name: start.name,
          prompt: start.prompt,
          slot: now,
          timeZone: defaultTimeZone,
        });
        const taken = await db.transaction(async (tx) => {
          await lockConversation(tx, found!.conversationId);
          return receive(sdk, tx, {
            id: uuidv7(),
            botId: found!.id,
            conversationId: found!.conversationId,
            source: "routine",
            channel: "webhook",
            text: `${snapshot}\n\n${webhookPayloadLabel}\n\`\`\`\n${start.payload}\n\`\`\``,
            receivedAt: now,
          });
        });
        turnId = turnIdOf(taken);
        sdk.runner.wake();
      }
      const turn = await waitForTurn(env, turnId, 5 * 60_000);
      toolCalls = toolCallsOf(turn.transcript);
      sent = sentTexts(turn.transcript);

      for (const entry of (await computer.list(directory)) ?? []) {
        if (entry.kind !== "directory") continue;
        const bytes = await computer.readFile(`${directory}/${entry.name}/SKILL.md`);
        if (bytes) after[entry.name] = new TextDecoder().decode(bytes);
      }
      const score = scoreSkills(evalCase.expect, {
        status: turn.status,
        calls: toolCalls,
        sent,
        skills: after,
        seeded: Object.keys(evalCase.skills),
      });
      return { ...base, score, sent, toolCalls, skills: after, ms: Date.now() - started };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      return {
        ...base,
        score: { passed: false, reasons: [`error: ${error}`] },
        sent,
        toolCalls,
        skills: after,
        ms: Date.now() - started,
        error,
      };
    }
  }

  const chosen = skillsCases.filter((evalCase) => !group || evalCase.group === group);
  const cases = limit === undefined ? chosen : chosen.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Skills eval${fake ? " (fake adapter)" : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
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
  const groups = ["use", "save", "follow-fix"] as const;
  for (const name of groups) {
    const own = results.filter((result) => result.group === name);
    if (own.length === 0) continue;
    const passed = own.filter((result) => result.score.passed).length;
    console.log(`${name.padEnd(11)} ${passed}/${own.length} passed`);
  }
  // A run that errored says nothing about the Bot, so it is left out of the rates.
  const rates = useRates(results.filter((result) => !result.error));
  console.log(
    `\nUse: hit ${percent(rates.hit)} of ${rates.uses} Skill cases, wrong Skill ${percent(rates.wrong)}, ` +
      `needless read ${percent(rates.needless)} of ${rates.nones} no-Skill cases`,
  );
  const unasked = results.filter((result) => result.expected.kind === "save-unasked");
  if (unasked.length > 0) {
    const saved = unasked.filter((result) => result.score.saved).length;
    console.log(
      `Save: saved unasked after a long repeatable task in ${saved} of ${unasked.length} runs`,
    );
  }
  const passed = results.filter((result) => result.score.passed).length;
  console.log(`overall     ${passed}/${results.length} passed`);

  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `skills-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(
    file,
    JSON.stringify({ startedAt, fake, model, repeats, rates, passed, runs: results }, null, 2),
  );
  console.log(`\nEvery run (tool calls, replies, Skills) is in ${file}`);
  await jobs.stop();
  await db.$client.end();
  // The SDK's timers are not all cleared once a Turn ends, so the script exits here.
  process.exit(passed === results.length ? 0 : 1);
}

await main();
