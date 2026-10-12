/// <reference types="node" />
/**
 * Smoke test for the example Host's chat path, without Next.js. It recreates a fresh database,
 * migrates it the way `db:migrate` does, then sends a real Run through the SDK's handler to the
 * fake Provider and checks the streamed reply and the saved Message.
 *
 * The fake Provider must already be running (`pnpm fake-provider`, or FAKE_PROVIDER_PORT). The
 * script waits up to 10 s for it, then fails. Run it with `pnpm smoke`.
 */
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import pg from "pg";

import { createChatClient } from "../src/chat-sdk/core/client/chat-client.ts";
import { createChat } from "../src/chat-sdk/core/server/create-chat.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adminUrl =
  process.env.SMOKE_ADMIN_URL ?? "postgresql://postgres:password@localhost:5434/postgres";
const databaseName = "ai-chat_smoke";
const providerUrl = `http://localhost:${process.env.FAKE_PROVIDER_PORT ?? 11436}`;
const model = "ollama:fake-model";
const keyEncryptionSecrets = ["smoke-key-encryption-secret-not-for-production"];

/** Drops and recreates the smoke database, and returns its URL. */
async function freshDatabase(): Promise<string> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function waitForProvider() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${providerUrl}/api/tags`)).ok) return;
    } catch {
      // Not listening yet; retry until the deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `No fake Provider answers at ${providerUrl}. Start it with: pnpm -F @ai-chat/example-next-prisma fake-provider`,
      );
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** The AG-UI events in a server-sent events body, as parsed objects. */
function eventsOf(body: string): { type: string; delta?: string }[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)) as { type: string; delta?: string });
}

async function main() {
  const databaseUrl = await freshDatabase();
  execSync("pnpm db:migrate", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  await waitForProvider();

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const user = await prisma.user.create({
    data: { email: "smoke@example.test", passwordHash: "smoke-no-sign-in" },
  });
  const chat = createChat({
    databaseUrl,
    keyEncryptionSecrets,
    basePath: "/api/chat",
    getUser: () => ({ id: user.id }),
  });
  await chat.start();

  try {
    const client = createChatClient({ baseUrl: "http://localhost/api/chat", fetch: chat.handler });
    await client.rpc.credentials.save({ service: "ollama", fields: { host: providerUrl } });
    const { id: conversationId } = await client.rpc.conversation.create({ model });

    const response = await chat.handler(
      new Request("http://localhost/api/chat/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          forwardedProps: {
            conversationId,
            parentId: null,
            text: "Hello from the smoke test",
            model,
            attachmentIds: [],
            webSearch: false,
          },
        }),
        signal: AbortSignal.timeout(60_000),
      }),
    );
    if (!response.ok) throw new Error(`Run answered ${response.status}: ${await response.text()}`);
    const events = eventsOf(await response.text());
    const types = events.map((event) => event.type);
    if (!types.includes("RUN_STARTED")) throw new Error(`No RUN_STARTED in ${types.join(", ")}`);
    if (!types.includes("RUN_FINISHED"))
      throw new Error(`The Run did not finish: ${types.join(", ")}`);

    const streamed = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta ?? "")
      .join("");
    if (!streamed.includes("You said")) throw new Error(`Unexpected reply: ${streamed}`);

    const saved = await client.rpc.conversation.get({ id: conversationId });
    const reply = saved.messages.find((message) => message.role === "assistant");
    if (!reply || !JSON.stringify(reply.parts).includes("You said")) {
      throw new Error("The assistant Message was not saved");
    }
    console.log(`Smoke test passed: streamed ${streamed.length} characters and saved the reply.`);
  } finally {
    await chat.stop();
    await prisma.$disconnect();
  }
}

// The SDK's database pool has no close, so the process is ended explicitly once the test is done.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
