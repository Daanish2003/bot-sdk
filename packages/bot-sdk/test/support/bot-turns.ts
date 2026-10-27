import { uuidv7 } from "@botsdk/bot/lib/uuidv7";
import { inProcessRunner, type JobRunner } from "@botsdk/bot/runner/internal";
import { createTestSdk, type TestDeps, type TestDepsOverrides } from "./deps";
import { followSend, type BotSendEvent } from "./follow-send";
import { chatRpc } from "./sdk";
import { getTestDb } from "./test-database";
import type { TestUser } from "./users";

/*
 * Bot Turns over the test SDK, for the tests of kept behaviour that a Turn drives: usage, Quota,
 * credentials, user deletion and Admin. A file that uses `botSdk` calls `stopBotRunners` after each
 * test.
 */

/** The runners `botSdk` started and `stopBotRunners` has not stopped yet. */
const started: JobRunner[] = [];

/**
 * A test SDK whose in-process runner runs the Turns' jobs. It drains for only 50 ms, so a Turn a
 * test leaves hanging is aborted. An `idle` runner never claims a job, so a Turn stays queued.
 */
export async function botSdk(
  overrides: TestDepsOverrides = {},
  { idle = false }: { idle?: boolean } = {},
): Promise<{ deps: TestDeps; jobs: JobRunner }> {
  let deps: TestDeps | undefined;
  const jobs = inProcessRunner({
    db: getTestDb(),
    logger: { error: () => {} },
    drainMs: 50,
    jobs: () => deps!.parts.jobs,
  });
  deps = createTestSdk({ ...overrides, jobs });
  if (!idle) await jobs.start();
  started.push(jobs);
  return { deps, jobs };
}

/** Stops every runner `botSdk` started. */
export async function stopBotRunners(): Promise<void> {
  for (const jobs of started.splice(0)) await jobs.stop();
}

/** `user`'s client over `deps`, and a new Bot of theirs on `model`. */
export async function botOf(deps: TestDeps, user: TestUser, model: string) {
  const client = chatRpc({ user, deps });
  const { id: botId } = await client.bots.create({ name: "Ada", model });
  return { client, botId };
}

/** Sends `text` to the Bot and reads its Turn to the end: the Messages, then how it ended. */
export async function sendToTurnEnd(
  client: ReturnType<typeof chatRpc>,
  botId: string,
  text = "Hi",
): Promise<BotSendEvent[]> {
  const events: BotSendEvent[] = [];
  for await (const event of await followSend(client, { botId, id: uuidv7(), text }))
    events.push(event);
  return events;
}
