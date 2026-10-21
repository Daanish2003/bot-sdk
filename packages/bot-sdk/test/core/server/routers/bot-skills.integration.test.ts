import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { botPromptStart } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { bot } from "../../../../plugins/bot/server/plugin";
import { computer } from "../../../../plugins/computer/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
  systemClock,
} from "../../../../plugins/runner/server/jobs/in-process";
import { skills } from "../../../../plugins/skills/server/plugin";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";

const model = "openai:gpt-5.6";
const silent = { error: () => {} };

type Round = ReturnType<typeof round>;

const now = new Date("2030-03-15T12:00:00Z");

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

const encode = (text: string) => new TextEncoder().encode(text);
const skillPath = (botId: string, folder: string) =>
  `/home/user/bots/${botId}/skills/${folder}/SKILL.md`;
const profilePath = (botId: string) => `/home/user/bots/${botId}/memory/profile.md`;

/** A `SKILL.md` with `name` and `description` in its frontmatter, and a body. */
const skillFile = (name: string, description: string, body = "## Steps\n1. Do it.\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

const isTurnCall = (options: TextOptions) =>
  String((options.messages as ModelMessage[] | undefined)?.[0]?.content).startsWith(
    "[Your environment]",
  );

/**
 * A user with an OpenAI key and a Bot "Ada". `computer`, `memory` and `skills` are on unless told
 * otherwise. The Model plays `turnRounds` in the Bot's Turn calls, in order, and answers the memory
 * pass with nothing.
 */
async function botWith(
  turnRounds: Round[],
  { withComputer = true, withSkills = true, withMemory = true } = {},
) {
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
    plugins: [
      bot(),
      ...(withComputer ? [computer({ provider: computerFake.provider })] : []),
      ...(withSkills ? [skills()] : []),
    ],
    memory: withMemory,
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
  return { fake, computerFake, client, botId };
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

const messagesOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];
const turnCalls = (calls: TextOptions[]) => calls.filter(isTurnCall);
const systemOf = (call: TextOptions | undefined) =>
  (call?.systemPrompts ?? []).map((prompt) =>
    typeof prompt === "string" ? prompt : prompt.content,
  );

/** The newest message of the first Turn call whose newest message holds `text`. */
function newestWith(calls: TextOptions[], text: string): string {
  for (const call of turnCalls(calls)) {
    const newest = String(messagesOf(call).at(-1)?.content);
    if (newest.includes(text)) return newest;
  }
  throw new Error(`No call's newest message holds "${text}"`);
}

const sectionNames = async (botId: string) => {
  const [start] = await getTestDb()
    .select()
    .from(botPromptStart)
    .where(eq(botPromptStart.botId, botId));
  return start!.sections.map((section) => section.name);
};

const header = (botId: string) =>
  `Your Skills are in \`/home/user/bots/${botId}/skills/<name>/SKILL.md\`. Before you do a task ` +
  "one covers, read its SKILL.md.";

describe("the Skills block", () => {
  it("lists each Skill as `- <name>: <description>`, sorted by name, with a broken one not usable", async () => {
    const { fake, computerFake, client, botId } = await botWith([round()]);
    computerFake.files.set(
      skillPath(botId, "weekly-report"),
      encode(skillFile("weekly-report", "Use this when the user asks for the weekly report.")),
    );
    computerFake.files.set(
      skillPath(botId, "expense-sheet"),
      encode(skillFile("expense-sheet", "Use this when an expense needs logging.")),
    );
    // Extra files in a Skill's folder are ignored.
    computerFake.files.set(
      `/home/user/bots/${botId}/skills/expense-sheet/scripts/fill.sh`,
      encode("echo hi"),
    );
    computerFake.files.set(
      skillPath(botId, "invoices"),
      encode(skillFile("invoice", "Use this when an invoice arrives.")),
    );
    computerFake.files.set(
      skillPath(botId, "Bad_Name"),
      encode(skillFile("Bad_Name", "Use this when it is bad.")),
    );
    computerFake.files.set(
      skillPath(botId, "no-when"),
      encode(skillFile("no-when", "Logs expenses.")),
    );
    computerFake.files.set(
      skillPath(botId, "too-long"),
      encode(skillFile("too-long", `Use this when ${"x".repeat(200)}`)),
    );
    computerFake.files.set(skillPath(botId, "bare"), encode("Just steps, no frontmatter.\n"));
    computerFake.files.set(`/home/user/bots/${botId}/skills/empty/notes.md`, encode("x"));
    // A SKILL.md that can't be read spoils only its own line.
    computerFake.files.set(`${skillPath(botId, "odd")}/inside.md`, encode("x"));
    // A folder name may hold ": ".
    computerFake.files.set(skillPath(botId, "deploy: prod"), encode("no frontmatter"));
    computerFake.files.set(profilePath(botId), encode("- Prefers short replies\n"));

    await send(client, botId, "hi");

    const system = systemOf(turnCalls(fake.calls)[0]);
    expect(system).toHaveLength(4);
    expect(system[2]).toMatch(/^Your memory/);
    const block = system[3]!;
    const lines = block.split("\n");
    expect(lines[0]).toBe(header(botId));
    expect(block).toContain("Helper");
    expect(lines.filter((line) => line.startsWith("- "))).toEqual([
      "- Bad_Name: (not usable: name must be lowercase a-z, 0-9 and -, at most 64 characters)",
      "- bare: (not usable: no frontmatter)",
      "- deploy: prod: (not usable: no frontmatter)",
      "- empty: (not usable: no SKILL.md)",
      "- expense-sheet: Use this when an expense needs logging.",
      '- invoices: (not usable: name "invoice" must equal the folder name)',
      '- no-when: (not usable: description must start with "Use this when")',
      "- odd: (not usable: SKILL.md can't be read)",
      "- too-long: (not usable: description is over 200 characters)",
      "- weekly-report: Use this when the user asks for the weekly report.",
    ]);
  });

  it("sits after the memory snapshot and before the Routines", async () => {
    const { computerFake, client, botId } = await botWith([
      round(
        toolCall({
          name: "create_routine",
          input: {
            name: "morning-brief",
            prompt: "Summarise the news.",
            schedule: { days: ["mon"], at: "08:00" },
          },
        }),
      ),
      round(),
      round(),
    ]);
    computerFake.files.set(profilePath(botId), encode("- Prefers short replies\n"));
    await send(client, botId, "save a routine");
    // The next Turn builds a new Prompt start, now with a Routine.
    await getTestDb().delete(botPromptStart).where(eq(botPromptStart.botId, botId));
    await send(client, botId, "hi");

    expect(await sectionNames(botId)).toEqual([
      "rules",
      "computer",
      "memory",
      "skills",
      "routines",
      "first_message",
    ]);
  });

  it("caps the list at 8,000 characters and says how many more there are", async () => {
    const { fake, computerFake, client, botId } = await botWith([round()]);
    for (let index = 0; index < 60; index++) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      computerFake.files.set(
        skillPath(botId, name),
        encode(skillFile(name, `Use this when ${"a".repeat(170)} ${index}.`)),
      );
    }

    await send(client, botId, "hi");

    const block = systemOf(turnCalls(fake.calls)[0]).at(-1)!;
    expect(block.length).toBeLessThanOrEqual(8_000);
    const listed = block.split("\n").filter((line) => line.startsWith("- "));
    expect(listed.length).toBeGreaterThan(30);
    expect(listed.length).toBeLessThan(60);
    expect(listed[0]).toMatch(/^- skill-00: /);
    expect(block.split("\n").at(-1)).toBe(
      `${60 - listed.length} more Skills: list \`skills/\` to see them`,
    );
  });

  it("is there with the user's Memory off", async () => {
    const { fake, computerFake, client, botId } = await botWith([round()]);
    await client.memory.setEnabled({ enabled: false });
    computerFake.files.set(
      skillPath(botId, "expense-sheet"),
      encode(skillFile("expense-sheet", "Use this when an expense needs logging.")),
    );

    await send(client, botId, "hi");

    const system = systemOf(turnCalls(fake.calls)[0]);
    expect(system.join("\n")).not.toContain("Your memory");
    expect(system.at(-1)).toContain("- expense-sheet: Use this when an expense needs logging.");
  });

  it("is absent without the skills plugin, or without a Computer", async () => {
    for (const options of [{ withSkills: false }, { withComputer: false, withMemory: false }]) {
      const { fake, client, botId } = await botWith([round()], options);
      await send(client, botId, "hi");
      expect(systemOf(turnCalls(fake.calls)[0]).join("\n")).not.toContain("Your Skills");
      expect(await sectionNames(botId)).not.toContain("skills");
    }
  });
});

describe("Skills Change notes", () => {
  it("keep the Prompt start byte-identical and note a Skill added, changed and removed, once each", async () => {
    const { fake, computerFake, client, botId } = await botWith([
      round(),
      round(),
      round(),
      round(),
      round(),
    ]);
    computerFake.files.set(
      skillPath(botId, "expense-sheet"),
      encode(skillFile("expense-sheet", "Use this when an expense needs logging.")),
    );

    await send(client, botId, "turn one");
    computerFake.files.set(
      skillPath(botId, "weekly-report"),
      encode(skillFile("weekly-report", "Use this when the user asks for the weekly report.")),
    );
    await send(client, botId, "turn two");
    // A body edit needs no note: the Bot reads the file fresh.
    computerFake.files.set(
      skillPath(botId, "weekly-report"),
      encode(
        skillFile(
          "weekly-report",
          "Use this when the user asks for the weekly report.",
          "## Steps\n1. Open the sheet.\n2. Sum it.\n",
        ),
      ),
    );
    await send(client, botId, "turn three");
    computerFake.files.set(
      skillPath(botId, "weekly-report"),
      encode(skillFile("weekly-report", "Use this when the user asks for a weekly summary.")),
    );
    await send(client, botId, "turn four");
    computerFake.files.delete(skillPath(botId, "expense-sheet"));
    await send(client, botId, "turn five");

    const calls = turnCalls(fake.calls);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(JSON.stringify(call.systemPrompts)).toBe(JSON.stringify(calls[0]!.systemPrompts));
      expect(messagesOf(call)[0]?.content).toBe(messagesOf(calls[0])[0]?.content);
    }
    expect(newestWith(fake.calls, "turn one")).not.toContain("Skill");
    expect(newestWith(fake.calls, "turn two")).toContain(
      "Skill added: weekly-report: Use this when the user asks for the weekly report.",
    );
    expect(newestWith(fake.calls, "turn three")).not.toContain("Skill");
    const fourth = newestWith(fake.calls, "turn four");
    expect(fourth).toContain(
      "Skill changed: weekly-report: Use this when the user asks for a weekly summary.",
    );
    expect(fourth).not.toContain("Skill added");
    const fifth = newestWith(fake.calls, "turn five");
    expect(fifth).toContain("Skill removed: expense-sheet");
    expect(fifth).not.toContain("weekly-report");
  });

  it("note a Skill whose frontmatter broke as changed, with its reason", async () => {
    const { fake, computerFake, client, botId } = await botWith([round(), round()]);
    computerFake.files.set(
      skillPath(botId, "expense-sheet"),
      encode(skillFile("expense-sheet", "Use this when an expense needs logging.")),
    );
    // A folder whose name holds ": " is the same Skill every Turn.
    computerFake.files.set(skillPath(botId, "deploy: prod"), encode("no frontmatter"));
    await send(client, botId, "turn one");
    computerFake.files.set(
      skillPath(botId, "expense-sheet"),
      encode(skillFile("expense-sheet", "Logs expenses.")),
    );
    await send(client, botId, "turn two");

    const second = newestWith(fake.calls, "turn two");
    expect(second).toContain(
      'Skill changed: expense-sheet: (not usable: description must start with "Use this when")',
    );
    expect(second).not.toContain("deploy");
  });

  it("hold the Skills notes to 8,000 characters, then say how many more changed", async () => {
    const { fake, computerFake, client, botId } = await botWith([round(), round()]);
    await send(client, botId, "turn one");
    for (let index = 0; index < 60; index++) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      computerFake.files.set(
        skillPath(botId, name),
        encode(skillFile(name, `Use this when ${"a".repeat(170)} ${index}.`)),
      );
    }
    await send(client, botId, "turn two");

    const notes = newestWith(fake.calls, "turn two")
      .split("\n")
      .filter((line) => line.startsWith("Skill"));
    const added = notes.filter((line) => line.startsWith("Skill added: "));
    expect(added.join("\n").length).toBeLessThanOrEqual(8_000);
    expect(added.length).toBeGreaterThan(30);
    expect(notes.at(-1)).toBe(
      `Skill changes: ${60 - added.length} more; list \`skills/\` to see them`,
    );
  });
});
