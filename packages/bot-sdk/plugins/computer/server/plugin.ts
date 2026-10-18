import { eq } from "drizzle-orm";

import { computer as computerTable } from "../../../core/server/db/schema";
import type { BotSdkContext, BotSdkPlugin } from "../../../core/server/plugin";
import type { CommandResult, ComputerProvider } from "./provider";

export type ComputerOptions = {
  /** What runs the Computers: E2B, or the tests' fake. */
  provider: ComputerProvider;
};

/**
 * One user's Computer. Every operation wakes it first when it isn't awake (a first create, or a
 * resume), and records activity when it starts and when it finishes.
 */
export type ComputerHandle = {
  /** Runs `command` with `bash -l -c` in `cwd` (the home directory by default). */
  run: (command: string, options?: { cwd?: string }) => Promise<CommandResult>;
};

/** The `computer` plugin's API (`sdk.plugin("computer")`). */
export type ComputerApi = {
  forUser: (userId: string) => ComputerHandle;
};

declare module "../../../core/server/plugin" {
  interface PluginApis {
    computer: ComputerApi;
  }
}

export type ComputerPlugin = BotSdkPlugin<"computer", never, never>;

/**
 * The `computer` plugin (ADR 0020): one Computer per user, shared by all their Bots, on the
 * `provider`. It exposes operations, not tools: `bot` builds its tools from them.
 */
export function computer({ provider }: ComputerOptions): ComputerPlugin {
  return {
    id: "computer",
    requires: ["runner"],
    init: (sdk) => {
      const api: ComputerApi = {
        forUser: (userId) => ({
          run: async (command, options = {}) => {
            const sandboxId = await startOperation(sdk, provider, userId);
            try {
              return await provider.run(sandboxId, command, { cwd: options.cwd });
            } finally {
              await recordActivity(sdk, userId);
            }
          },
        }),
      };
      return { api };
    },
    // The row goes with its user, and its sandbox id is collected. Killing that sandbox after the
    // commit is the user delete ticket's (#525).
    deleteUser: {
      before: async (_sdk, { userId, tx }) => {
        const [deleted] = await tx
          .delete(computerTable)
          .where(eq(computerTable.userId, userId))
          .returning({ sandboxId: computerTable.sandboxId });
        return deleted?.sandboxId ?? null;
      },
      after: async () => {},
    },
  };
}

/**
 * An operation's start: records activity, creating the row on the user's first operation, and
 * returns the sandbox to act on, waking the Computer first when it isn't awake.
 */
async function startOperation(
  sdk: BotSdkContext,
  provider: ComputerProvider,
  userId: string,
): Promise<string> {
  const now = sdk.clock();
  const [row] = await sdk.db
    .insert(computerTable)
    .values({ userId, state: "asleep", lastActiveAt: now, createdAt: now })
    .onConflictDoUpdate({ target: computerTable.userId, set: { lastActiveAt: now } })
    .returning({ state: computerTable.state, sandboxId: computerTable.sandboxId });
  if (row?.state === "awake" && row.sandboxId) return row.sandboxId;
  return wake(sdk, provider, userId);
}

/**
 * Wakes the user's Computer under its row lock, which covers only this step: creates its sandbox
 * when it has none, else resumes it. Another operation that woke it meanwhile wins, and this one
 * uses its sandbox.
 */
async function wake(sdk: BotSdkContext, provider: ComputerProvider, userId: string) {
  return sdk.db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(computerTable)
      .where(eq(computerTable.userId, userId))
      .for("update");
    if (!locked) throw new Error(`The Computer of user ${userId} has no row`);
    if (locked.state === "awake" && locked.sandboxId) return locked.sandboxId;
    if (locked.sandboxId) {
      await provider.resume(locked.sandboxId);
      await tx
        .update(computerTable)
        .set({ state: "awake" })
        .where(eq(computerTable.userId, userId));
      return locked.sandboxId;
    }
    const { sandboxId } = await provider.create();
    await tx
      .update(computerTable)
      .set({ state: "awake", sandboxId, template: provider.template })
      .where(eq(computerTable.userId, userId));
    return sandboxId;
  });
}

/**
 * An operation's finish: records activity again, so a long command doesn't count as idle time.
 * A failure is logged, never thrown: the operation has already happened, and a throw would have
 * its caller run it again.
 */
async function recordActivity(sdk: BotSdkContext, userId: string) {
  try {
    await sdk.db
      .update(computerTable)
      .set({ lastActiveAt: sdk.clock() })
      .where(eq(computerTable.userId, userId));
  } catch (caught) {
    sdk.logger.error(`Recording the activity of the Computer of user ${userId} failed`, caught);
  }
}
