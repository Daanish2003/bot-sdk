import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { computer as computerTable } from "@botsdk/bot/storage";
import { e2bProvider } from "../src";
import { computerIdleMs } from "@botsdk/bot/computer/internal";
import { createTestSdk } from "@ai-chat/test-support/deps";
import { drainJobs } from "@ai-chat/test-support/jobs";
import { getTestDb } from "@ai-chat/test-support/test-database";
import { insertOwner } from "@ai-chat/test-support/users";

// Against a real self-hosted E2B (hand-run: see the SDK README). Skipped when it is not set up.
const apiKey = process.env.E2B_API_KEY;
const apiUrl = process.env.E2B_API_URL;
const sandboxUrl = process.env.E2B_SANDBOX_URL;

describe.skipIf(!apiKey || !apiUrl || !sandboxUrl)("the computer plugin on real E2B", () => {
  const provider = () =>
    e2bProvider({
      apiKey: apiKey!,
      apiUrl: apiUrl!,
      sandboxUrl: sandboxUrl!,
      template: "ai-chat-computer-v3",
    });
  const users: string[] = [];
  afterEach(async () => {
    const rows = await getTestDb().select().from(computerTable);
    await Promise.all(
      rows
        .filter((row) => users.includes(row.userId) && row.sandboxId)
        .map((row) => provider().kill(row.sandboxId!)),
    );
    users.length = 0;
  });

  it("runs a command, keeps a file across a sleep, and wakes with it", async () => {
    const clock = { now: new Date() };
    const logged: unknown[][] = [];
    const sdk = createTestSdk({
      computer: provider(),
      clock: () => clock.now,
      logger: { error: (...args: unknown[]) => logged.push(args) },
    });
    const user = await insertOwner();
    users.push(user.id);
    const handle = sdk.computer!.forUser(user.id);

    expect(await handle.run("echo hi")).toMatchObject({ exitCode: 0, stdout: "hi\n" });
    await handle.writeFile("/home/user/bots/a/note.txt", "remember");

    clock.now = new Date(clock.now.getTime() + computerIdleMs + 1000);
    await drainJobs({ deps: sdk, respectRunAfter: true, now: clock.now });
    const asleep = (
      await getTestDb().select().from(computerTable).where(eq(computerTable.userId, user.id))
    )[0];
    expect(asleep).toMatchObject({ state: "asleep", syncedAt: expect.any(Date) });

    expect(logged).toEqual([]);
    const bytes = await handle.readFile("/home/user/bots/a/note.txt");
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe("remember");
    const awake = (
      await getTestDb().select().from(computerTable).where(eq(computerTable.userId, user.id))
    )[0];
    expect(awake).toMatchObject({ state: "awake", sandboxId: asleep?.sandboxId });
  }, 120_000);
});
