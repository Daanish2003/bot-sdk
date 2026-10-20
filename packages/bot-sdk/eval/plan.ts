// Runs an eval on the owner's linked ChatGPT plan in one command (#637):
//
//   pnpm -F @ai-chat/bot-sdk eval:plan <turn|ladder|memory> [--limit=<n>]
//
// It loads the web app's settings from `apps/web/.env`, finds the user who linked ChatGPT in the dev
// database, defaults the Models to the plan's, then runs the eval. A variable already set wins over
// the file and the defaults, so `EVAL_REPEATS=1 pnpm ... eval:plan turn` works as usual.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { account } from "@ai-chat/db/schema/auth";
import { eq } from "drizzle-orm";

import { createDb } from "../core/server/db/index";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** Each eval's script, and the Models it runs on the plan unless they are set. */
const evals: Record<string, { file: string; models: Record<string, string> }> = {
  turn: {
    file: "eval/turn/run.ts",
    models: { EVAL_BOT_MODEL: "openai:gpt-6-luna", EVAL_JUDGE_MODEL: "openai:gpt-6.1-sol" },
  },
  ladder: {
    file: "eval/turn/ladder.ts",
    models: { EVAL_BOT_MODEL: "openai:gpt-6-luna", EVAL_JUDGE_MODEL: "openai:gpt-6.1-sol" },
  },
  memory: {
    file: "eval/memory/run.ts",
    models: {
      EVAL_BACKGROUND_MODEL: "openai:gpt-6-luna",
      EVAL_ANSWER_MODEL: "openai:gpt-6.1-sol",
      EVAL_JUDGE_MODEL: "openai:gpt-6.1-sol",
    },
  },
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The one user who linked ChatGPT in the web app's database. */
async function linkedUserId(databaseUrl: string): Promise<string> {
  const db = createDb({ DATABASE_URL: databaseUrl });
  try {
    const rows = await db
      .selectDistinct({ userId: account.userId })
      .from(account)
      .where(eq(account.providerId, "chatgpt"));
    if (rows.length === 0)
      fail("No user has linked ChatGPT: connect it on the web app's Keys page.");
    if (rows.length > 1) {
      fail(
        `Several users linked ChatGPT; set EVAL_CHATGPT_USER_ID to one of: ${rows.map((row) => row.userId).join(", ")}`,
      );
    }
    return rows[0]!.userId;
  } finally {
    await db.$client.end();
  }
}

async function main() {
  const [name, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
  const chosen = name ? evals[name] : undefined;
  if (!chosen)
    fail(
      `usage: pnpm -F @ai-chat/bot-sdk eval:plan <${Object.keys(evals).join("|")}> [--limit=<n>]`,
    );

  try {
    process.loadEnvFile(fileURLToPath(new URL("../../../apps/web/.env", import.meta.url)));
  } catch {
    fail("apps/web/.env could not be read: the plan needs the web app's settings.");
  }
  const databaseUrl = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set in apps/web/.env");
  process.env.EVAL_CHATGPT_USER_ID ??= await linkedUserId(databaseUrl);
  process.env.EVAL_DATABASE_URL ??= "postgresql://postgres:password@127.0.0.1:5435/ai-chat_eval";
  for (const [variable, model] of Object.entries(chosen.models)) process.env[variable] ??= model;

  console.log(`On the ChatGPT plan of user ${process.env.EVAL_CHATGPT_USER_ID}`);
  const child = spawn(
    process.execPath,
    ["--import", "./eval/memory/register-ts.mjs", chosen.file, ...rest],
    { cwd: packageDir, stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => process.exit(code ?? 1));
}

await main();
