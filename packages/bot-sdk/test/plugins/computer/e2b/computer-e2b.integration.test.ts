import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { computer as computerTable } from "../../../../core/server/db/schema";
import { e2bProvider } from "../../../../plugins/computer/e2b";
import { computer, computerIdleMs } from "../../../../plugins/computer/server/plugin";
import { createTestSdk } from "../../../support/deps";
import { drainJobs } from "../../../support/jobs";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";

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
      template: "ai-chat-computer-v2",
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
      plugins: [computer({ provider: provider() })],
      clock: () => clock.now,
      logger: { error: (...args: unknown[]) => logged.push(args) },
    });
    const user = await insertUser();
    users.push(user.id);
    const handle = sdk.plugin("computer").forUser(user.id);

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
