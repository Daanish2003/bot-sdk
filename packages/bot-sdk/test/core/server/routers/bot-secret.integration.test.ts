import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  botReview,
  botSecret,
  botTrigger,
  botTurn,
  job,
  jobEvent,
  message,
} from "../../../../core/server/storage";
import { encryptCredentials } from "../../../../core/server/credentials/encryption";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { deleteUserData } from "../../../../core/server/user-data";
import { richControlJsonSchema } from "../../../../plugins/bot/client/index";
import { secretNameSchema } from "../../../../plugins/bot/shared/secret";
import {
  rotateSecretKeys,
  loadSecretValues,
  secretEncryption,
} from "../../../../plugins/bot/server/safety";
import type { CommandResult } from "../../../../plugins/computer/server/internal";
import { saveCredentials } from "../../../../plugins/models/server/internal";
import { inProcessRunner, type JobRunner } from "../../../../plugins/runner/server/internal";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeReviewer } from "../../../support/fake-reviewer";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider, type FakeCommandRun } from "../../../support/fake-computer-provider";
import { followSend } from "../../../support/follow-send";

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };
const token = "ghp_s3cr3t-Value+/=42";

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: JobRunner[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with an OpenAI key and a Bot with its Computer, whose Model plays `rounds`. */
async function botWith(
  rounds: Round[],
  {
    onCommand,
  }: { onCommand?: (command: FakeCommandRun) => CommandResult | Promise<CommandResult> } = {},
) {
  const fake = createFakeAdapter({ rounds });
  const computerFake = fakeComputerProvider({ onCommand });
  const reviewer = fakeReviewer();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: silent,
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({
    computer: computerFake.provider,
    jobs,
    adapterFor: () => fake.adapter,
    reviewAdapterFor: () => reviewer.adapter,
    memory: false,
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
  const { id: botId } = await client.bots.create({ name: "Ada", model });
  return { fake, computerFake, deps, client, user, botId };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, words: string) {
  const events = [];
  for await (const event of await followSend(client, { botId, id: uuidv7(), text: words })) {
    events.push(event);
  }
  return events;
}

const asks = (name: string) =>
  toolCall({
    name: "send_to_user",
    input: {
      text: `I need ${name} to push.`,
      endTurn: true,
      secret: { name, why: "To push to your repository." },
    },
  });
const sends = (words: string) =>
  toolCall({ name: "send_to_user", input: { text: words, endTurn: true } });
const shell = (command: string, secrets?: string[]) =>
  toolCall({ name: "shell", input: { command, ...(secrets && { secrets }) } });

const inputOf = (call: TextOptions | undefined) => (call?.messages ?? []) as ModelMessage[];
const toolResultOf = (call: TextOptions | undefined) =>
  JSON.parse(String(inputOf(call).findLast((entry) => entry.role === "tool")?.content));

const turnsOf = (botId: string) =>
  getTestDb()
    .select()
    .from(botTurn)
    .where(eq(botTurn.botId, botId))
    .orderBy(asc(botTurn.startedAt));

/** Waits until the Bot has run `count` Turns and none is running. */
const turnsEnded = (botId: string, count: number) =>
  expect
    .poll(
      async () => {
        const turns = await turnsOf(botId);
        return turns.length === count && turns.every((turn) => turn.status !== "running");
      },
      { timeout: 10_000 },
    )
    .toBe(true);

/** Stores a Secret for the user directly, as `secret.save` does, without waking the Bot. */
async function storeSecret(deps: TestDeps, userId: string, name: string, value: string) {
  await getTestDb()
    .insert(botSecret)
    .values({
      userId,
      name,
      encrypted: encryptCredentials({ value }, secretEncryption(deps, userId, name)),
      createdAt: new Date(),
    });
}

/** Every place the value could have been written: all of them as one text. */
async function everythingStored() {
  const db = getTestDb();
  const tables = await Promise.all([
    db.select().from(message),
    db.select().from(botTrigger),
    db.select().from(botTurn),
    db.select().from(botReview),
    db.select().from(job),
    db.select().from(jobEvent),
  ]);
  return JSON.stringify(tables);
}

describe("Secrets", () => {
  it("asks with a Secret card, saves the value encrypted and wakes the Bot with its name", async () => {
    const { client, botId, user, fake } = await botWith([
      round(asks("GITHUB_TOKEN")),
      round(sends("Thanks, I have it.")),
    ]);

    await send(client, botId, "push my changes");
    const { messages } = await client.bots.get({ botId });
    const request = messages.find((sent) => sent.control?.kind === "secret");
    expect(request).toMatchObject({
      role: "assistant",
      text: "I need GITHUB_TOKEN to push.",
      control: { kind: "secret", name: "GITHUB_TOKEN", why: "To push to your repository." },
    });

    await client.secrets.save({ botId, name: "GITHUB_TOKEN", value: token });
    await turnsEnded(botId, 2);

    // The stored row is ciphertext, bound to the user and the name.
    const [row] = await getTestDb().select().from(botSecret).where(eq(botSecret.userId, user.id));
    expect(row).toMatchObject({ name: "GITHUB_TOKEN" });
    expect(row!.encrypted).toMatch(/^v2\./);
    expect(row!.encrypted).not.toContain(token);
    // The Trigger carries the name only, and the woken Turn reads it.
    const triggers = await getTestDb().select().from(botTrigger);
    expect(triggers.find((trigger) => trigger.text)).toMatchObject({
      source: "user",
      channel: "web",
      messageId: null,
      text: "Saved secret GITHUB_TOKEN",
    });
    expect(JSON.stringify(inputOf(fake.calls[1]))).toContain("Saved secret GITHUB_TOKEN");
    // The value is nowhere: not the Conversation, a Trigger, a transcript, a model call or a job.
    expect(await everythingStored()).not.toContain(token);
    expect(JSON.stringify(fake.calls.map((call) => call.messages))).not.toContain(token);
  });

  it("stores the request as a Rich control that the published JSON Schema accepts", async () => {
    const { client, botId } = await botWith([round(asks("GITHUB_TOKEN"))]);

    await send(client, botId, "push my changes");

    const rows = await getTestDb()
      .select({ parts: message.parts })
      .from(message)
      .where(eq(message.role, "assistant"));
    const stored = rows.flatMap((row) => row.parts.parts as unknown[]);
    const controls = stored.filter((part) => (part as { type: string }).type === "control");
    expect(controls).toEqual([
      {
        type: "control",
        control: { kind: "secret", name: "GITHUB_TOKEN", why: "To push to your repository." },
      },
    ]);
    const published = z.fromJSONSchema(richControlJsonSchema);
    expect(published.safeParse((controls[0] as { control: unknown }).control).success).toBe(true);
    expect(published.safeParse({ kind: "secret", name: "GITHUB_TOKEN" }).success).toBe(false);
  });

  it("lists names and dates, never values, and deletes", async () => {
    const { client, botId } = await botWith([]);
    await client.secrets.save({ botId, name: "B_TOKEN", value: "twos" });
    await client.secrets.save({ botId, name: "A_TOKEN", value: "ones" });

    const listed = await client.secrets.list();
    expect(listed).toEqual([
      { name: "A_TOKEN", createdAt: expect.any(Date) },
      { name: "B_TOKEN", createdAt: expect.any(Date) },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/ones|twos/);

    await client.secrets.delete({ name: "A_TOKEN" });
    expect((await client.secrets.list()).map((secret) => secret.name)).toEqual(["B_TOKEN"]);
  });

  it("keeps a user's Secrets from other users, and removes them with the user", async () => {
    const { client, botId, deps, user } = await botWith([]);
    await client.secrets.save({ botId, name: "GITHUB_TOKEN", value: token });
    const other = chatRpc({ user: await insertUser(), deps });

    expect(await other.secrets.list()).toEqual([]);
    await expect(
      other.secrets.save({ botId, name: "GITHUB_TOKEN", value: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await deleteUserData(deps, user.id);
    expect(await getTestDb().select().from(botSecret)).toEqual([]);
  });

  it("re-encrypts Secrets under the keyring's first key when keys are rotated", async () => {
    const { deps, user } = await botWith([]);
    await storeSecret(deps, user.id, "GITHUB_TOKEN", token);
    const newKey = "key-b-of-at-least-32-characters-long!!";
    const rotated = { ...deps, keyring: [newKey, ...deps.keyring] };

    expect(await rotateSecretKeys(rotated)).toEqual({ reencrypted: 1, unreadable: 0 });
    expect(await rotateSecretKeys(rotated)).toEqual({ reencrypted: 0, unreadable: 0 });

    // The old key can be removed: the Secret reads under the new one alone.
    const values = await loadSecretValues({ ...deps, keyring: [newKey] }, user.id);
    expect(values.get("GITHUB_TOKEN")).toBe(token);
  });

  it("refuses a name that is not an environment variable name", async () => {
    const { client, botId } = await botWith([]);

    await expect(
      client.secrets.save({ botId, name: "my token", value: "x" }),
    ).rejects.toBeDefined();
  });

  it("refuses a reserved name, which would change how every command runs", async () => {
    const { client, botId, deps, user } = await botWith([]);

    await expect(
      client.secrets.save({ botId, name: "LD_PRELOAD", value: "/tmp/evil.so" }),
    ).rejects.toBeDefined();
    expect(secretNameSchema.safeParse("LD_PRELOAD").error?.message).toMatch(/reserved/);
    for (const name of ["BASH_FUNC_ECHO", "PATH", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"]) {
      await expect(client.secrets.save({ botId, name, value: "x" })).rejects.toBeDefined();
    }
    expect(await loadSecretValues(deps, user.id)).toEqual(new Map());
    await client.secrets.save({ botId, name: "GITHUB_TOKEN", value: token });
    expect(await loadSecretValues(deps, user.id)).toEqual(new Map([["GITHUB_TOKEN", token]]));
  });

  it("refuses a Secret request for a reserved name", async () => {
    const { client, botId, fake } = await botWith([
      round(asks("LD_PRELOAD")),
      round(sends("Sorry.")),
    ]);

    await send(client, botId, "log in");

    expect(JSON.stringify(toolResultOf(fake.calls.at(-1)))).toMatch(/reserved/);
    expect((await client.bots.get({ botId })).messages.some((entry) => entry.control)).toBe(false);
  });

  it("does not set a reserved name for a command, even one that was stored", async () => {
    const { client, botId, deps, user, fake, computerFake } = await botWith([
      round(shell("env", ["LD_PRELOAD"])),
      round(sends("Done.")),
    ]);
    await storeSecret(deps, user.id, "LD_PRELOAD", "/tmp/evil.so");

    await send(client, botId, "env");

    expect(JSON.stringify(toolResultOf(fake.calls.at(-1)))).toMatch(/reserved/);
    expect(computerFake.callsOf("run").some((call) => call.command === "env")).toBe(false);
  });

  it("gives a command only the Secrets it names, as its environment, and masks them in the output", async () => {
    const base64 = Buffer.from(token).toString("base64");
    const encoded = encodeURIComponent(token);
    const { client, botId, deps, user, fake, computerFake } = await botWith(
      [round(shell("gh auth status", ["GITHUB_TOKEN"])), round(sends("Done."))],
      {
        onCommand: ({ envs }) => ({
          exitCode: 0,
          stdout: `raw=${envs?.GITHUB_TOKEN} b64=${base64} url=${encoded} other=${envs?.OTHER_TOKEN}`,
          stderr: `err ${envs?.GITHUB_TOKEN}`,
        }),
      },
    );
    await storeSecret(deps, user.id, "GITHUB_TOKEN", token);
    await storeSecret(deps, user.id, "OTHER_TOKEN", "other-value");

    await send(client, botId, "check my login");

    const [run] = computerFake.callsOf("run").filter((call) => call.command === "gh auth status");
    expect(run?.envs).toEqual({ GITHUB_TOKEN: token });
    const result = toolResultOf(fake.calls.at(-1));
    expect(result.stdout).toBe("raw=*** b64=*** url=*** other=undefined");
    expect(result.stderr).toBe("err ***");
    expect(await everythingStored()).not.toContain(token);
    expect(await everythingStored()).not.toContain(base64);
  });

  it("masks a value that a command prints without naming the Secret", async () => {
    const { client, botId, deps, user, fake } = await botWith(
      [round(shell("env")), round(sends("Done."))],
      {
        onCommand: () => ({ exitCode: 0, stdout: `GITHUB_TOKEN=${token}\n`, stderr: "" }),
      },
    );
    await storeSecret(deps, user.id, "GITHUB_TOKEN", token);

    await send(client, botId, "show env");

    expect(toolResultOf(fake.calls.at(-1)).stdout).toBe("GITHUB_TOKEN=***\n");
  });

  it("stores a value trimmed, so the output that holds the trimmed value is masked", async () => {
    const { client, botId, deps, user, fake } = await botWith(
      [round(sends("Thanks.")), round(shell("env")), round(sends("Done."))],
      {
        onCommand: () => ({ exitCode: 0, stdout: `GITHUB_TOKEN=${token}\n`, stderr: "" }),
      },
    );
    await client.secrets.save({ botId, name: "GITHUB_TOKEN", value: `  ${token}\n` });
    expect(await loadSecretValues(deps, user.id)).toEqual(new Map([["GITHUB_TOKEN", token]]));
    await turnsEnded(botId, 1);

    await send(client, botId, "show env");

    expect(toolResultOf(fake.calls.at(-1)).stdout).toBe("GITHUB_TOKEN=***\n");
  });

  it("refuses a value shorter than 4 characters once trimmed", async () => {
    const { client, botId, deps, user } = await botWith([]);

    for (const value of ["abc", "  abc \n", "   "]) {
      await expect(
        client.secrets.save({ botId, name: "GITHUB_TOKEN", value }),
      ).rejects.toMatchObject({ data: { code: "error.secretTooShort" } });
    }
    expect(await loadSecretValues(deps, user.id)).toEqual(new Map());
    await client.secrets.save({ botId, name: "GITHUB_TOKEN", value: "abcd" });
    expect(await loadSecretValues(deps, user.id)).toEqual(new Map([["GITHUB_TOKEN", "abcd"]]));
  });

  it("masks the trimmed form of a stored value and skips one too short, so older rows are safe", async () => {
    const { client, botId, deps, user, fake } = await botWith(
      [round(shell("env")), round(sends("Done."))],
      {
        onCommand: () => ({
          exitCode: 0,
          stdout: `a=1 b=2 TOKEN=${token}\n`,
          stderr: "",
        }),
      },
    );
    await storeSecret(deps, user.id, "SHORT", "a");
    await storeSecret(deps, user.id, "PADDED_SHORT", " 2 \n");
    await storeSecret(deps, user.id, "GITHUB_TOKEN", `${token}\n`);

    expect(await loadSecretValues(deps, user.id)).toEqual(new Map([["GITHUB_TOKEN", token]]));
    await send(client, botId, "show env");

    expect(toolResultOf(fake.calls.at(-1)).stdout).toBe("a=1 b=2 TOKEN=***\n");
  });

  it("masks the value before a long output is cut, so none of it is kept", async () => {
    const long = `${"x".repeat(1_990)}${token}${"y".repeat(20_000)}`;
    const { client, botId, deps, user, fake } = await botWith(
      [round(shell("cat big")), round(sends("Done."))],
      { onCommand: () => ({ exitCode: 0, stdout: long, stderr: "" }) },
    );
    await storeSecret(deps, user.id, "GITHUB_TOKEN", token);

    await send(client, botId, "cat it");

    const result = toolResultOf(fake.calls.at(-1));
    expect(result.stdout).toContain("***");
    expect(JSON.stringify(result)).not.toContain(token.slice(0, 12));
  });

  it("masks a value in a file the Bot reads", async () => {
    const { client, botId, deps, user, fake } = await botWith([
      round(toolCall({ name: "write", input: { path: "notes.txt", content: `login ${token}\n` } })),
      round(toolCall({ name: "read", input: { path: "notes.txt" } })),
      round(sends("Done.")),
    ]);
    await storeSecret(deps, user.id, "GITHUB_TOKEN", token);

    await send(client, botId, "read my notes");

    const result = toolResultOf(fake.calls.at(-1));
    expect(JSON.stringify(result)).toContain("login ***");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("masks a value in a long line the Bot reads before the line is cut", async () => {
    // The value starts 5 characters before `read` cuts a line, at 2,000 characters.
    const line = `${"x".repeat(1_995)}${token}${"y".repeat(100)}`;
    const { client, botId, deps, user, fake } = await botWith([
      round(toolCall({ name: "write", input: { path: "long.txt", content: `${line}\n` } })),
      round(toolCall({ name: "read", input: { path: "long.txt" } })),
      round(sends("Done.")),
    ]);
    await storeSecret(deps, user.id, "GITHUB_TOKEN", token);

    await send(client, botId, "read it");

    const result = toolResultOf(fake.calls.at(-1));
    expect(JSON.stringify(result)).toContain("***");
    expect(JSON.stringify(result)).not.toContain(token.slice(0, 5));
  });

  it("answers a Secret the user does not have with an error that lists the names, and runs nothing", async () => {
    const { client, botId, deps, user, fake, computerFake } = await botWith([
      round(shell("deploy", ["NPM_TOKEN"])),
      round(sends("Done.")),
    ]);
    await storeSecret(deps, user.id, "GITHUB_TOKEN", token);

    await send(client, botId, "deploy");

    expect(toolResultOf(fake.calls.at(-1))).toEqual({
      error: "No Secret named NPM_TOKEN. The user's Secrets are: GITHUB_TOKEN.",
    });
    expect(computerFake.callsOf("run").some((call) => call.command === "deploy")).toBe(false);
  });
});
