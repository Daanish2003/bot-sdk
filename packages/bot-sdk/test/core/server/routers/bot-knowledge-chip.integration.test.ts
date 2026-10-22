import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botTurn } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import { knowledge } from "../../../../plugins/knowledge/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };
const now = new Date("2030-03-15T12:00:00Z");
const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const isTurnCall = (options: TextOptions) =>
  String((options.messages as ModelMessage[] | undefined)?.[0]?.content).startsWith(
    "[Your environment]",
  );

/** A user with an OpenAI key and a Bot "Ada"; the Model plays `turnRounds` in the Bot's Turn calls. */
async function botWith(turnRounds: ReturnType<typeof round>[]) {
  const queue = [...turnRounds];
  const fake = createFakeAdapter({
    rounds: Array.from(
      { length: 60 },
      () => (options: TextOptions) => (isTurnCall(options) ? (queue.shift() ?? round()) : round()),
    ),
  });
  const computerFake = fakeComputerProvider();
  const offset = now.getTime() - Date.now();
  const clock = () => new Date(Date.now() + offset);
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    clock: { ...systemClock, now: clock },
    deps: () => deps!,
  });
  deps = createTestSdk({
    plugins: [bot(), computer({ provider: computerFake.provider }), knowledge()],
    jobs,
    adapterFor: () => fake.adapter,
    clock,
  });
  await jobs.start();
  started.push(jobs);
  const user = await insertUser();
  await saveCredentials(deps, user.id, {
    service: "openai",
    fields: { apiKey: "openai-test-key" },
    hint: "…-key",
    verified: true,
  });
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bot.create({ name: "Ada", model });
  return { computerFake, client, botId };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  for await (const _event of await client.bot.send({
    botId,
    id: uuidv7(),
    text,
    timeZone: "Europe/London",
  })) {
    // Read to the end of the Turn.
  }
}

describe("the Knowledge chip's record on the Turn", { timeout: 30_000 }, () => {
  it("records a write or edit under shared/knowledge, and ignores other writes", async () => {
    const { computerFake, client, botId } = await botWith([
      round(
        toolCall({
          name: "write",
          input: { path: "/home/user/shared/knowledge/reports/q3.md", content: "Revenue grew." },
        }),
      ),
      round(),
      round(
        toolCall({ name: "write", input: { path: "notes/a.txt", content: "one" } }),
        toolCall({
          name: "write",
          input: { path: "/home/user/shared/other/b.md", content: "two" },
        }),
      ),
      round(),
      round(
        toolCall({
          name: "edit",
          input: {
            path: "/home/user/shared/knowledge/reports/q3.md",
            oldText: "grew.",
            newText: "grew 4%.",
          },
        }),
      ),
      round(),
    ]);
    await send(client, botId, "keep the report");
    await send(client, botId, "write some notes");
    await send(client, botId, "fix the report");

    expect(computerFake.files.has("/home/user/shared/knowledge/reports/q3.md")).toBe(true);
    const turns = await getTestDb()
      .select({ knowledgeChanges: botTurn.knowledgeChanges })
      .from(botTurn)
      .where(eq(botTurn.botId, botId))
      .orderBy(asc(botTurn.startedAt), asc(botTurn.id));
    expect(turns.map((turn) => turn.knowledgeChanges)).toEqual([
      [{ botId, path: "reports/q3.md" }],
      null,
      [{ botId, path: "reports/q3.md" }],
    ]);
    expect((await client.knowledgeFiles.list()).files).toEqual([
      { path: "reports/q3.md", size: 16, savedBy: "bot", botName: "Ada" },
    ]);
  });
});
