import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { computer as computerTable } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
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
import { followSend } from "../../../support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

/** The fake clock's "now": every Turn starts a few milliseconds after it. */
const now = new Date("2030-03-15T12:00:00Z");

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const memoryPath = (botId: string, file: string) => `/home/user/bots/${botId}/memory/${file}`;

/** A user with an OpenAI key and the Bots `names` (oldest first), whose Model plays `rounds`. */
async function botsWith(
  rounds: Round[],
  { names = ["Ada"], withComputer = true }: { names?: string[]; withComputer?: boolean } = {},
) {
  const fake = createFakeAdapter({ rounds });
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
    plugins: withComputer ? [bot(), computer({ provider: computerFake.provider })] : [bot()],
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
  const botIds: string[] = [];
  for (const name of names) botIds.push((await client.bot.create({ name, model })).id);
  const seed = (botId: string, file: string, lines: string[]) =>
    computerFake.files.set(
      memoryPath(botId, file),
      new TextEncoder().encode(`${lines.join("\n")}\n`),
    );
  return { fake, client, botIds, seed, computerFake, deps, user };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, text: string) {
  for await (const _event of await followSend(client, { botId, id: uuidv7(), text })) {
    // Read to the end of the Turn.
  }
}

const search = (query: string) => toolCall({ name: "search_memory", input: { query } });

type Hit = { file: string; date: string | null; bot?: string; text: string };

/** The result the Model got for the last tool call in its input to call `call`, parsed. */
const resultsOf = (call: TextOptions | undefined): Hit[] =>
  JSON.parse(
    String(
      ((call?.messages ?? []) as ModelMessage[]).findLast((entry) => entry.role === "tool")
        ?.content,
    ),
  ).results;

const toolNamesOf = (call: TextOptions | undefined) => (call?.tools ?? []).map((tool) => tool.name);

describe("the search_memory tool", () => {
  it("returns lines across the Bot's own files and the other Bots' Profiles, never another Bot's Log or Notes", async () => {
    const { client, botIds, fake, seed } = await botsWith([round(search("espresso")), round()], {
      names: ["Ada", "Bea"],
    });
    const [ada, bea] = botIds as [string, string];
    seed(ada, "profile.md", ["- Loves espresso"]);
    seed(ada, "log/2030-03.md", ["- 2030-03-10 (importance 5) Bought an espresso machine"]);
    seed(ada, "log/2029-06.md", ["- 2029-06-01 (importance 5) First espresso in Rome"]);
    seed(ada, "notes.md", ["- 2030-03-14 Descale the espresso machine"]);
    seed(bea, "profile.md", ["- Hates espresso"]);
    // Not Ada's to read.
    seed(bea, "log/2030-03.md", ["- 2030-03-15 (importance 10) Bea's espresso secret"]);
    seed(bea, "notes.md", ["- 2030-03-15 Bea's espresso errand"]);

    await send(client, ada, "what about espresso?");

    const results = resultsOf(fake.calls[1]);
    const shape = (hit: Hit) => [hit.file.replace("/home/user/bots/", ""), hit.date, hit.text];
    expect(results.map(shape)).toEqual(
      expect.arrayContaining([
        [`${ada}/memory/profile.md`, null, "Loves espresso"],
        [`${ada}/memory/log/2030-03.md`, "2030-03-10", "Bought an espresso machine"],
        [`${ada}/memory/log/2029-06.md`, "2029-06-01", "First espresso in Rome"],
        [`${ada}/memory/notes.md`, "2030-03-14", "Descale the espresso machine"],
        [`${bea}/memory/profile.md`, null, "Hates espresso"],
      ]),
    );
    expect(results).toHaveLength(5);
    expect(results.find((hit) => hit.file.includes(bea))?.bot).toBe("Bea");
  });

  it("returns at most 10 lines", async () => {
    const { client, botIds, fake, seed } = await botsWith([round(search("tea")), round()]);
    const [ada] = botIds as [string];
    seed(
      ada,
      "profile.md",
      Array.from({ length: 15 }, (_, i) => `- Drinks tea number ${i}`),
    );

    await send(client, ada, "tea?");

    expect(resultsOf(fake.calls[1])).toHaveLength(10);
  });

  it("ranks a strong old match above a weak new one, and importance and age break near ties", async () => {
    const { client, botIds, fake, seed } = await botsWith([
      round(search("marathon training plan")),
      round(),
    ]);
    const [ada] = botIds as [string];
    seed(ada, "log/2030-03.md", [
      "- 2030-03-14 (importance 5) Started a plan for the garden",
      "- 2030-03-14 (importance 2) Marathon training plan: week one done",
      "- 2030-03-14 (importance 9) Marathon training plan: week two done",
      "- 2030-03-01 (importance 9) Marathon training plan: week three done",
    ]);
    seed(ada, "log/2030-02.md", [
      "- 2030-02-13 (importance 5) Marathon training plan marathon training plan marathon training plan",
    ]);

    await send(client, ada, "the plan?");

    const texts = resultsOf(fake.calls[1]).map((hit) => hit.text);
    const rank = (text: string) => texts.indexOf(text);
    // Importance breaks the tie between two same-day lines; age, between two equally important.
    expect(rank("Marathon training plan: week two done")).toBeLessThan(
      rank("Marathon training plan: week one done"),
    );
    expect(rank("Marathon training plan: week two done")).toBeLessThan(
      rank("Marathon training plan: week three done"),
    );
    // A month-old line that matches the phrase three times beats yesterday's one-word match.
    expect(
      rank("Marathon training plan marathon training plan marathon training plan"),
    ).toBeLessThan(rank("Started a plan for the garden"));
  });

  it("is absent with Memory off or with no computer plugin, and present otherwise", async () => {
    const off = await botsWith([round()]);
    await off.client.memory.setEnabled({ enabled: false });
    await send(off.client, off.botIds[0]!, "hi");
    expect(toolNamesOf(off.fake.calls[0])).not.toContain("search_memory");

    const none = await botsWith([round()], { withComputer: false });
    await send(none.client, none.botIds[0]!, "hi");
    expect(toolNamesOf(none.fake.calls[0])).not.toContain("search_memory");

    const on = await botsWith([round()]);
    await send(on.client, on.botIds[0]!, "hi");
    expect(toolNamesOf(on.fake.calls[0])).toContain("search_memory");
  });

  it("tells the Bot its Computer was rebuilt, in its first result after the rebuild", async () => {
    const { client, botIds, fake, computerFake, deps, user } = await botsWith([
      round(search("espresso")),
      round(),
    ]);
    const [ada] = botIds as [string];
    await deps.plugin("computer").forUser(user.id).list("/home/user");
    // The Computer sleeps and its sandbox is lost: the next call rebuilds it.
    await getTestDb()
      .update(computerTable)
      .set({ state: "asleep" })
      .where(eq(computerTable.userId, user.id));
    computerFake.lose(computerFake.callsOf("create")[0]!.sandboxId);

    await send(client, ada, "what about espresso?");

    const result = JSON.parse(
      String(
        ((fake.calls[1]?.messages ?? []) as ModelMessage[]).findLast(
          (entry) => entry.role === "tool",
        )?.content,
      ),
    );
    expect(result.note).toContain("Your computer was rebuilt");
  });
});
