import { sendAndFollow } from "../../test/support/follow-send";
// The Connectors eval (spec #801, ticket #807): real Turns on a real Model, through the real `bot` and
// `mcp` plugins, each case's user with a "Linear" Connection over the SDK's fake MCP server. It
// scores whether a Bot uses the connector before the browser or web search, tells the user when the
// connector is broken, and ignores instructions planted in a tool result. Run it with
// `pnpm -F @ai-chat/bot-sdk eval:connectors`; see eval/connectors/README.md.
//
// The Computer is the fake one, in every mode: no case needs real files, and a case scores what the
// Bot tries, not what runs.
//
// `--fake` (or EVAL_FAKE=1) runs the same wiring with the SDK's fake chat adapter, which plays each
// case's `good` script, for checking the harness and the scorers with no Model or key. With
// `--broken` it plays the `broken` script, what a deliberately broken prompt makes a Bot do, and
// every gating case must then FAIL: that is how a case is seen to fail before it is trusted.
// `--limit=<n>` runs the first n cases; `--case=<id>` only that case.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import type { AnyTextAdapter, TextOptions } from "@tanstack/ai";

import { botTrigger } from "@botsdk/bot/storage";
import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { saveTokens } from "@botsdk/mcp/server/connections";
import { mcp } from "@botsdk/mcp";
import { runnerJobs } from "@botsdk/bot/runner/internal";
import { createFakeAdapter, round, toolCall } from "../../test/support/fake-adapter";
import { type FakeMcpAuth, fakeMcpResource } from "../../test/support/fake-mcp-auth";
import { createFakeMcpServer, type FakeMcpServer } from "../../test/support/fake-mcp-server";
import { isReviewCall, passVerdict, verdictRound } from "../../test/support/fake-reviewer";
import { fakeComputerProvider } from "../../test/support/fake-computer-provider";
import { chatgptPlanFromEnv } from "../chatgpt-plan";
import { createComputerSdk, databaseUrlFromEnv, prepareSchema } from "../computer/setup";
import { fail, keyFor } from "../turn/judge-model";
import { freshBot, type TurnEnv } from "../turn/case";
import { toolCallsOf } from "../turn/routine-score";
import { waitForTurn } from "../turn/routine-run";
import { type ConnectorsCase, connectorsCases, linearServer, linearTools } from "./cases";
import { type Call, type Expect, type Score, scoreConnectors, tallyConnectors } from "./score";

const here = fileURLToPath(new URL(".", import.meta.url));
const resultsDir = join(here, "results");

/** The Bots' Model unless told otherwise: the step's default on OpenRouter. */
const defaultModel = "openrouter:anthropic/claude-sonnet-5.5";

/** The adapter, except that an Auto-review call (a Connector tool that needs one) gets a pass. */
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

/** The fake MCP server checks no token itself: each run's server is found by its token. */
const anyToken = { accepts: () => true } as unknown as FakeMcpAuth;

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
  if (only && !connectorsCases.some((evalCase) => evalCase.id === only)) {
    fail(`--case must be one of ${connectorsCases.map((evalCase) => evalCase.id).join(", ")}`);
  }
  const model = process.env.EVAL_BOT_MODEL ?? defaultModel;
  // `null`: the Model runs on the owner's ChatGPT plan (eval/chatgpt-plan.ts), not on a key.
  const plan = fake ? null : await chatgptPlanFromEnv();
  const apiKey = fake ? "sk-fake" : keyFor(model, plan, " (no Model key: nothing ran)");
  const databaseUrl = databaseUrlFromEnv();

  const db = await prepareSchema(databaseUrl);
  /** Each run's fake MCP server, by the access token its user's Connection holds. */
  const servers = new Map<string, FakeMcpServer>();
  const mcpEndpoint = new URL(fakeMcpResource);
  /** The fake Model, one adapter per run (found by its API key). */
  const adapters = new Map<string, AnyTextAdapter>();
  const sdk = createComputerSdk({
    db,
    provider: fakeComputerProvider().provider,
    features: [
      mcp({
        servers: [
          {
            ...linearServer,
            url: fakeMcpResource,
            oauth: { clientId: "eval-client", clientSecret: "eval-secret" },
          },
        ],
      }),
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
      const evalCase = connectorsCases.find((c) => c.id === caseId)!;
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

  async function runCase(evalCase: ConnectorsCase, repeat: number): Promise<RunResult> {
    const started = Date.now();
    const base = {
      caseId: evalCase.id,
      gating: evalCase.gating,
      repeat,
      expected: evalCase.expect,
    };
    let toolCalls: Call[] = [];
    try {
      const { userId, bot: made } = await freshBot(env, evalCase.id, repeat);
      // The user's Linear Connection: a token that never expires, served by this run's own server.
      const token = `eval-${evalCase.id}-${repeat}-${randomUUID()}`;
      const server = createFakeMcpServer({
        auth: anyToken,
        tools: linearTools(evalCase.listResult),
      });
      server.failCalls = evalCase.failCalls ?? false;
      servers.set(token, server);
      await saveTokens(sdk, userId, linearServer.key, {
        accessToken: token,
        tokenType: "Bearer",
        scope: "read write",
      });
      const triggerId = uuidv7();
      for await (const _ of await sendAndFollow(sdk, {
        userId,
        botId: made.id,
        id: triggerId,
        text: evalCase.message,
      })) {
        // Drained: the stream ends when the Turn does.
      }
      const turn = await waitForTurn(env, await turnTaking(triggerId), 5 * 60_000);
      toolCalls = toolCallsOf(turn.transcript);
      const score = scoreConnectors(evalCase.expect, { status: turn.status, calls: toolCalls });
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

  const chosen = connectorsCases.filter((evalCase) => !only || evalCase.id === only);
  const cases = limit === undefined ? chosen : chosen.slice(0, limit);
  const runs = cases.flatMap((evalCase) =>
    Array.from({ length: repeats }, (_, repeat) => ({ evalCase, repeat })),
  );
  const startedAt = new Date().toISOString();
  console.log(
    `Connectors eval${fake ? (broken ? " (fake adapter, BROKEN scripts)" : " (fake adapter)") : ""}: ${cases.length} cases x ${repeats} repeats, Model ${model}`,
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
    console.log(`${evalCase.id.padEnd(18)} ${passed}/${own.length} passed`);
  }
  const tally = tallyConnectors(results);
  console.log(`\nGating: ${tally.gating.passed}/${tally.gating.total} passed.`);
  // The broken scripts must all fail. A run that errored is not a failed score, so it doesn't count,
  // nor does one caught only because its Turn broke.
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
    `connectors-${broken ? "broken-" : ""}${startedAt.replace(/[:.]/g, "-")}.json`,
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
