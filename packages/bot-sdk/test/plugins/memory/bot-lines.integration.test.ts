import { describe, expect, it } from "vitest";

import { memory } from "../../../plugins/memory/server/feature";
import { memorySettings } from "../../../plugins/memory/server/schema";
import { saveCredentials } from "../../../plugins/models/server/internal";
import { createTestSdk } from "../../support/deps";
import { chatRpc } from "../../support/sdk";
import { getTestDb } from "../../support/test-database";
import { insertUser } from "../../support/users";
import { fakeComputerProvider } from "../../support/fake-computer-provider";

const model = "openai:gpt-6-luna";
const now = new Date("2030-03-15T12:00:00Z");

const dir = (botId: string) => `/home/user/bots/${botId}/memory`;

/** Two Bots of one user on a fake Computer, and a second user with a Bot of their own. */
async function setup() {
  const computerFake = fakeComputerProvider();
  const deps = createTestSdk({
    computer: computerFake.provider,
    clock: () => now,
  });
  const make = async () => {
    const user = await insertUser();
    await saveCredentials(deps, user.id, {
      service: "openai",
      fields: { apiKey: "openai-test-key" },
      hint: "…-key",
      verified: true,
    });
    const client = chatRpc({ user, deps });
    const ada = (await client.bot.create({ name: "Ada", model })).id;
    const bea = (await client.bot.create({ name: "Bea", model })).id;
    return { user, client, ada, bea };
  };
  const mine = await make();
  const other = await make();
  const write = (path: string, lines: string[]) =>
    computerFake.files.set(path, new TextEncoder().encode(`${lines.join("\n")}\n`));
  const read = (path: string) => {
    const bytes = computerFake.files.get(path);
    return bytes ? new TextDecoder().decode(bytes) : null;
  };
  return { deps, mine, other, write, read };
}

describe("the Bot memory procedures", () => {
  it("lists the tiers with the other Bots' Profiles labelled and what the prompt holds", async () => {
    const { mine, write } = await setup();
    write(`${dir(mine.ada)}/profile.md`, ["- Lives in Berlin"]);
    write(`${dir(mine.bea)}/profile.md`, ["- Is vegan", "- Lives in Berlin"]);
    write(`${dir(mine.ada)}/log/2030-03.md`, [
      "- 2030-03-10 (importance 8) Moved flat",
      "- 2030-03-01 (importance 2) Bought a lamp",
    ]);
    write(`${dir(mine.ada)}/notes.md`, [
      "- 2030-03-15 Waiting on the landlord",
      "- 2030-01-02 Old",
    ]);

    const list = await mine.client.memory.botList({ botId: mine.ada });

    expect(list.enabled).toBe(true);
    expect(list.available).toBe(true);
    // The duplicate "Lives in Berlin" of Bea's is not in the prompt.
    expect(list.profile).toEqual([
      { botId: mine.ada, botName: null, line: 1, text: "Lives in Berlin", inPrompt: true },
      { botId: mine.bea, botName: "Bea", line: 1, text: "Is vegan", inPrompt: true },
      { botId: mine.bea, botName: "Bea", line: 2, text: "Lives in Berlin", inPrompt: false },
    ]);
    expect(list.log.map((l) => [l.date, l.importance, l.inPrompt])).toEqual([
      ["2030-03-10", 8, true],
      ["2030-03-01", 2, true],
    ]);
    expect(list.notes.map((n) => [n.date, n.inPrompt])).toEqual([
      ["2030-03-15", true],
      ["2030-01-02", false],
    ]);
  });

  it("says Memory is off, and reads nothing, with the switch off", async () => {
    const { mine, write } = await setup();
    write(`${dir(mine.ada)}/profile.md`, ["- Lives in Berlin"]);
    await getTestDb().insert(memorySettings).values({ userId: mine.user.id, enabled: false });

    expect(await mine.client.memory.botList({ botId: mine.ada })).toEqual({
      available: true,
      enabled: false,
      profile: [],
      log: [],
      notes: [],
    });
  });

  it("lists every Log month, the older ones search only", async () => {
    const { mine, write } = await setup();
    write(`${dir(mine.ada)}/log/2029-11.md`, ["- 2029-11-05 (importance 9) Got married"]);
    write(`${dir(mine.ada)}/log/2030-03.md`, ["- 2030-03-10 (importance 8) Moved flat"]);

    const list = await mine.client.memory.botList({ botId: mine.ada });

    expect(list.log.map((l) => [l.month, l.body, l.inPrompt])).toEqual([
      ["2030-03", "Moved flat", true],
      ["2029-11", "Got married", false],
    ]);
  });

  it("is a configuration error without a Computer: the feature needs one", () => {
    expect(() => createTestSdk({ features: [memory()] })).toThrow(
      /Feature "memory" needs the Computer/,
    );
  });

  it("edits, deletes and adds lines, and edits another Bot's Profile line", async () => {
    const { mine, write, read } = await setup();
    write(`${dir(mine.ada)}/profile.md`, ["# Profile", "- Lives in Berlin", "- Likes tea"]);
    write(`${dir(mine.bea)}/profile.md`, ["- Is vegan"]);
    const profile = { botId: mine.ada, tier: "profile" as const };

    await mine.client.memory.botEditLine({
      file: profile,
      line: 2,
      current: "Lives in Berlin",
      text: "Lives in Pune",
    });
    await mine.client.memory.botDeleteLine({ file: profile, line: 3, current: "Likes tea" });
    await mine.client.memory.botAddLine({ botId: mine.ada, tier: "profile", text: "Runs daily" });
    await mine.client.memory.botEditLine({
      file: { botId: mine.bea, tier: "profile" },
      line: 1,
      current: "Is vegan",
      text: "Is vegetarian",
    });
    await mine.client.memory.botAddLine({ botId: mine.ada, tier: "log", text: "Got a cat" });
    await mine.client.memory.botAddLine({ botId: mine.ada, tier: "notes", text: "Feed it" });

    expect(read(`${dir(mine.ada)}/profile.md`)).toBe("# Profile\n- Lives in Pune\n- Runs daily\n");
    expect(read(`${dir(mine.bea)}/profile.md`)).toBe("- Is vegetarian\n");
    expect(read(`${dir(mine.ada)}/log/2030-03.md`)).toBe("- 2030-03-15 (importance 5) Got a cat\n");
    expect(read(`${dir(mine.ada)}/notes.md`)).toBe("- 2030-03-15 Feed it\n");
  });

  it("refuses an edit or a delete of a line that changed underneath", async () => {
    const { mine, write, read } = await setup();
    write(`${dir(mine.ada)}/profile.md`, ["- Lives in Pune"]);
    const file = { botId: mine.ada, tier: "profile" as const };

    await expect(
      mine.client.memory.botEditLine({ file, line: 1, current: "Lives in Berlin", text: "x" }),
    ).rejects.toMatchObject({ data: { code: "error.memoryLineChanged" } });
    await expect(
      mine.client.memory.botDeleteLine({ file, line: 1, current: "Lives in Berlin" }),
    ).rejects.toMatchObject({ data: { code: "error.memoryLineChanged" } });
    await expect(
      mine.client.memory.botDeleteLine({ file, line: 5, current: "Lives in Pune" }),
    ).rejects.toMatchObject({ data: { code: "error.memoryLineChanged" } });

    expect(read(`${dir(mine.ada)}/profile.md`)).toBe("- Lives in Pune\n");
  });

  it("reads a file and saves it whole", async () => {
    const { mine, write, read } = await setup();
    write(`${dir(mine.ada)}/log/2030-02.md`, ["- 2030-02-02 Hello"]);
    const file = { botId: mine.ada, tier: "log" as const, month: "2030-02" };

    expect(await mine.client.memory.botReadFile({ file })).toEqual({
      content: "- 2030-02-02 Hello\n",
    });
    await mine.client.memory.botSaveFile({
      file,
      expected: "- 2030-02-02 Hello\n",
      content: "- 2030-02-03 Bye\n",
    });
    expect(read(`${dir(mine.ada)}/log/2030-02.md`)).toBe("- 2030-02-03 Bye\n");
    expect(
      await mine.client.memory.botReadFile({ file: { botId: mine.bea, tier: "notes" } }),
    ).toEqual({ content: "" });
  });

  it("refuses to save a file whole that changed since it was read", async () => {
    const { mine, write, read } = await setup();
    const file = { botId: mine.ada, tier: "profile" as const };
    write(`${dir(mine.ada)}/profile.md`, ["- Lives in Pune"]);

    await expect(
      mine.client.memory.botSaveFile({
        file,
        expected: "- Lives in Berlin\n",
        content: "- Lives in Paris\n",
      }),
    ).rejects.toMatchObject({ data: { code: "error.memoryLineChanged" } });

    expect(read(`${dir(mine.ada)}/profile.md`)).toBe("- Lives in Pune\n");
  });

  it("refuses a blank line and a Log file with no month", async () => {
    const { mine } = await setup();
    await expect(
      mine.client.memory.botAddLine({ botId: mine.ada, tier: "notes", text: "  " }),
    ).rejects.toMatchObject({ data: { code: "error.memoryTextBlank" } });
    await expect(
      mine.client.memory.botReadFile({ file: { botId: mine.ada, tier: "log" } }),
    ).rejects.toMatchObject({ data: { code: "error.memoryLogMonth" } });
  });

  it("refuses everyone but the owner, on every procedure", async () => {
    const { mine, other, write, read } = await setup();
    write(`${dir(mine.ada)}/profile.md`, ["- Lives in Pune"]);
    const file = { botId: mine.ada, tier: "profile" as const };
    const notFound = { data: { code: "error.botNotFound" } };

    await expect(other.client.memory.botList({ botId: mine.ada })).rejects.toMatchObject(notFound);
    await expect(
      other.client.memory.botEditLine({ file, line: 1, current: "Lives in Pune", text: "x" }),
    ).rejects.toMatchObject(notFound);
    await expect(
      other.client.memory.botDeleteLine({ file, line: 1, current: "Lives in Pune" }),
    ).rejects.toMatchObject(notFound);
    await expect(
      other.client.memory.botAddLine({ botId: mine.ada, tier: "profile", text: "x" }),
    ).rejects.toMatchObject(notFound);
    await expect(other.client.memory.botReadFile({ file })).rejects.toMatchObject(notFound);
    await expect(
      other.client.memory.botSaveFile({ file, expected: "", content: "x" }),
    ).rejects.toMatchObject(notFound);
    await expect(
      chatRpc({ user: null, deps: undefined }).memory.botList({ botId: mine.ada }),
    ).rejects.toBeDefined();

    expect(read(`${dir(mine.ada)}/profile.md`)).toBe("- Lives in Pune\n");
  });
});
