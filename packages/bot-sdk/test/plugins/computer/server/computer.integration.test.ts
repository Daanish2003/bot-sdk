import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { computer as computerTable } from "../../../../core/server/db/schema";
import { computer } from "../../../../plugins/computer/server/plugin";
import type { CommandResult } from "../../../../plugins/computer/server/provider";
import { createTestSdk } from "../../../support/deps";
import { getTestDb } from "../../../support/test-database";
import { insertUser } from "../../../support/users";
import { fakeComputerProvider, type FakeCommand } from "./fake-provider";

const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

/** An SDK with `computer` on over a fake provider, on a clock the test sets through `now`. */
function sdkWith({
  onCommand,
}: { onCommand?: (command: FakeCommand) => CommandResult | Promise<CommandResult> } = {}) {
  const clock = { now: new Date("2026-10-18T10:00:00Z") };
  const fake = fakeComputerProvider({ onCommand });
  const sdk = createTestSdk({
    plugins: [computer({ provider: fake.provider })],
    clock: () => clock.now,
  });
  return { sdk, fake, clock };
}

const computerRow = async (userId: string) =>
  (await getTestDb().select().from(computerTable).where(eq(computerTable.userId, userId)))[0];

describe("forUser(userId).run", () => {
  it("creates the row and the sandbox on the user's first operation", async () => {
    const { sdk, fake, clock } = sdkWith();
    const user = await insertUser();
    expect(await computerRow(user.id)).toBeUndefined();

    await sdk.plugin("computer").forUser(user.id).run("true");

    const [created] = fake.callsOf("create");
    expect(fake.callsOf("create")).toHaveLength(1);
    expect(await computerRow(user.id)).toEqual({
      userId: user.id,
      sandboxId: created?.sandboxId,
      template: "fake-computer-v1",
      state: "awake",
      lastActiveAt: clock.now,
      createdAt: clock.now,
    });
  });

  it("records activity when the command starts and again when it finishes", async () => {
    const started = new Date("2026-10-18T11:00:00Z");
    const finished = new Date("2026-10-18T11:03:00Z");
    let duringCommand: Date | undefined;
    const { sdk, clock } = sdkWith({
      onCommand: async () => {
        duringCommand = (await computerRow(user.id))?.lastActiveAt;
        clock.now = finished;
        return ok;
      },
    });
    const user = await insertUser();
    await sdk.plugin("computer").forUser(user.id).run("true");
    clock.now = started;

    await sdk.plugin("computer").forUser(user.id).run("sleep 180");

    expect(duringCommand).toEqual(started);
    expect((await computerRow(user.id))?.lastActiveAt).toEqual(finished);
  });

  it("returns the command's exit code and output, and runs where it is told", async () => {
    const { sdk, fake } = sdkWith({
      onCommand: () => ({ exitCode: 1, stdout: "out", stderr: "err" }),
    });
    const user = await insertUser();

    const result = await sdk.plugin("computer").forUser(user.id).run("false", { cwd: "/tmp" });

    expect(result).toEqual({ exitCode: 1, stdout: "out", stderr: "err" });
    expect(fake.callsOf("run").map(({ command, cwd }) => ({ command, cwd }))).toEqual([
      { command: "false", cwd: "/tmp" },
    ]);
  });

  it("wakes once for concurrent first operations", async () => {
    const { sdk, fake } = sdkWith();
    const user = await insertUser();
    const handle = sdk.plugin("computer").forUser(user.id);

    await Promise.all([handle.run("echo a"), handle.run("echo b"), handle.run("echo c")]);

    expect(fake.callsOf("create")).toHaveLength(1);
    expect(new Set(fake.callsOf("run").map((call) => call.sandboxId)).size).toBe(1);
  });
});

describe("hasPlugin", () => {
  it("says whether computer is enabled", () => {
    expect(sdkWith().sdk.hasPlugin("computer")).toBe(true);
    expect(createTestSdk().hasPlugin("computer")).toBe(false);
  });
});
