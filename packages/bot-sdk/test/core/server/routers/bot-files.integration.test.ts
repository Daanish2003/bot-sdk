import type { ModelMessage, TextOptions } from "@tanstack/ai";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { botTurn, message } from "../../../../core/server/db/schema";
import { uuidv7 } from "../../../../core/server/lib/uuidv7";
import { deleteUserData } from "../../../../core/server/user-data";
import { richControlJsonSchema } from "../../../../plugins/bot/client/index";
import { sentFileBlobKey, sentFileResponse } from "../../../../plugins/bot/server/files";
import { bot } from "../../../../plugins/bot/server/plugin";
import { saveCredentials } from "../../../../plugins/models/server/credentials/store";
import {
  inProcessRunner,
  type InProcessRunner,
} from "../../../../plugins/runner/server/jobs/in-process";
import { createTestSdk, type TestDeps } from "../../../support/deps";
import { createFakeAdapter, round, toolCall } from "../../../support/fake-adapter";
import { fakeReviewer } from "../../../support/fake-reviewer";
import { chatRpc } from "../../../support/sdk";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider } from "../../../plugins/computer/server/fake-provider";
import { followSend } from "../../../support/follow-send";

vi.setConfig({ testTimeout: 30_000 });

const model = "openai:gpt-6-luna";
const silent = { error: () => {} };

type Round = Parameters<typeof createFakeAdapter>[0]["rounds"][number];

const started: InProcessRunner[] = [];

afterEach(async () => {
  for (const jobs of started.splice(0)) await jobs.stop();
});

/** A user with an OpenAI key and a Bot with its Computer, whose Model plays `rounds`. */
async function botWith(rounds: Round[]) {
  const fake = createFakeAdapter({ rounds });
  const computerFake = fakeComputerProvider();
  const reviewer = fakeReviewer();
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({ db: getTestDb(), logger: silent, drainMs: 50, deps: () => deps! });
  deps = createTestSdk({
    computer: computerFake.provider,
    plugins: [bot()],
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
  const { id: botId } = await client.bot.create({ name: "Ada", model });
  return { fake, deps, client, user, botId };
}

async function send(client: ReturnType<typeof chatRpc>, botId: string, words: string) {
  for await (const _ of await followSend(client, { botId, id: uuidv7(), text: words }));
}

const sendsFiles = (words: string, files: string[]) =>
  toolCall({ name: "send_to_user", input: { text: words, endTurn: true, files } });

const toolResultOf = (call: TextOptions | undefined) =>
  JSON.parse(
    String(
      ((call?.messages ?? []) as ModelMessage[]).findLast((entry) => entry.role === "tool")
        ?.content,
    ),
  );

const turnsEnded = (botId: string) =>
  expect
    .poll(
      async () => {
        const turns = await getTestDb()
          .select()
          .from(botTurn)
          .where(eq(botTurn.botId, botId))
          .orderBy(asc(botTurn.startedAt));
        return turns.length > 0 && turns.every((turn) => turn.status !== "running");
      },
      { timeout: 10_000 },
    )
    .toBe(true);

describe("Files from the Bot", () => {
  it("copies existing paths to storage, saves a files control, and each file downloads", async () => {
    const { client, botId, deps, user } = await botWith([
      round(sendsFiles("Here is the report.", ["report.csv", "/home/user/shared/notes.txt"])),
    ]);
    const handle = deps.computer!.forUser(user.id);
    await handle.writeFile(`/home/user/bots/${botId}/report.csv`, "a,b\n1,2\n");
    await handle.writeFile("/home/user/shared/notes.txt", "hello");

    await send(client, botId, "send me the report");
    await turnsEnded(botId);

    const { messages } = await client.bot.get({ botId });
    const sent = messages.find((entry) => entry.control?.kind === "files")!;
    expect(sent).toMatchObject({ role: "assistant", text: "Here is the report." });
    const control = sent.control as Extract<typeof sent.control, { kind: "files" }>;
    expect(control.files).toMatchObject([
      { name: "report.csv", size: 8, mediaType: "text/csv" },
      { name: "notes.txt", size: 5, mediaType: "text/plain" },
    ]);
    // The control is in the published catalog.
    expect(z.fromJSONSchema(richControlJsonSchema).safeParse(control).success).toBe(true);

    // The bytes outlive the Computer's copy, and download as an attachment.
    await handle.writeFile(`/home/user/bots/${botId}/report.csv`, "changed");
    const response = await sentFileResponse(deps, user.id, control.files[0]!.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(await response.text()).toBe("a,b\n1,2\n");
    // Only its owner can download it.
    const other = await insertUser();
    expect((await sentFileResponse(deps, other.id, control.files[0]!.id)).status).toBe(404);
    expect((await sentFileResponse(deps, user.id, uuidv7())).status).toBe(404);
    expect((await sentFileResponse(deps, user.id, "not-an-id")).status).toBe(404);

    // Deleting the user deletes the files too.
    await deleteUserData(deps, user.id);
    expect(await deps.blobStore.get(sentFileBlobKey(control.files[0]!.id))).toBeNull();
  });

  it("serves an image inline to its owner only, and refuses other types inline", async () => {
    const { client, botId, deps, user } = await botWith([
      round(sendsFiles("Here are all three.", ["chart.png", "report.csv", "logo.svg"])),
    ]);
    const handle = deps.computer!.forUser(user.id);
    await handle.writeFile(`/home/user/bots/${botId}/chart.png`, "png-bytes");
    await handle.writeFile(`/home/user/bots/${botId}/report.csv`, "a,b\n");
    await handle.writeFile(`/home/user/bots/${botId}/logo.svg`, "<svg/>");

    await send(client, botId, "send all three");
    await turnsEnded(botId);

    const { messages } = await client.bot.get({ botId });
    const control = messages.find((entry) => entry.control?.kind === "files")!.control as Extract<
      NonNullable<(typeof messages)[number]["control"]>,
      { kind: "files" }
    >;
    const [png, csv, svg] = control.files;
    const inline = await sentFileResponse(deps, user.id, png!.id, { inline: true });
    expect(inline.status).toBe(200);
    expect(inline.headers.get("Content-Type")).toBe("image/png");
    expect(inline.headers.get("Content-Disposition")).toBe("inline");
    expect(await inline.text()).toBe("png-bytes");
    // The plain route is still a download.
    const download = await sentFileResponse(deps, user.id, png!.id);
    expect(download.headers.get("Content-Disposition")).toContain("attachment");
    // Not images (SVG can carry script), not the owner's, not a file: refused.
    for (const id of [csv!.id, svg!.id, uuidv7(), "not-an-id"])
      expect((await sentFileResponse(deps, user.id, id, { inline: true })).status).toBe(404);
    const other = await insertUser();
    expect((await sentFileResponse(deps, other.id, png!.id, { inline: true })).status).toBe(404);
  });

  it("fails the tool call on a missing path, saving no Message and storing nothing", async () => {
    const { client, botId, deps, user, fake } = await botWith([
      round(sendsFiles("Here you go.", ["report.csv", "missing.csv"])),
      round(
        toolCall({ name: "send_to_user", input: { text: "Sorry, it is gone.", endTurn: true } }),
      ),
    ]);
    const handle = deps.computer!.forUser(user.id);
    await handle.writeFile(`/home/user/bots/${botId}/report.csv`, "a,b\n");

    await send(client, botId, "send me the report");
    await turnsEnded(botId);

    const result = toolResultOf(fake.calls[1]);
    expect(result.error).toContain(`/home/user/bots/${botId}/missing.csv does not exist`);
    const { messages } = await client.bot.get({ botId });
    expect(messages.map((entry) => [entry.role, entry.text, entry.control?.kind])).toEqual([
      ["user", "send me the report", undefined],
      ["assistant", "Sorry, it is gone.", undefined],
    ]);
    const rows = await getTestDb().select({ parts: message.parts }).from(message);
    expect(JSON.stringify(rows)).not.toContain('"files"');
  });
});
