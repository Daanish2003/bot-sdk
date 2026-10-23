import { eq, inArray, type SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { deleteConversations } from "../../../core/server/chat/delete-conversations";
import { createHookEmitter } from "../../../core/server/chat/hooks";
import { bot, conversation } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, BotSdkPlugin } from "../../../core/server/plugin";
import { deleteUserData } from "../../../core/server/user-data";
import { bot as botPlugin } from "../../../plugins/bot/server/plugin";
import { insertConversation } from "../../support/conversations";
import { createTestSdk, type TestDeps } from "../../support/deps";
import { getTestDb } from "../../support/test-database";
import { insertUser, type TestUser } from "../../support/users";

type Call = { conversationIds: string[]; userId: string | null; collected?: unknown };

/**
 * A plugin whose Conversation delete hooks record each call. Its `before` collects how many of the
 * Conversations it can still see in the transaction, and its `after` receives that count.
 */
function recordingPlugin({ beforeThrows = false, afterThrows = false } = {}) {
  const before: Call[] = [];
  const after: Call[] = [];
  const plugin: BotSdkPlugin = {
    id: "recorder",
    databaseHooks: {
      conversation: {
        delete: {
          before: async (_sdk, { conversationIds, userId, tx }) => {
            before.push({ conversationIds: [...conversationIds].sort(), userId });
            if (beforeThrows) throw new Error("before failed");
            const rows = await tx
              .select({ id: conversation.id })
              .from(conversation)
              .where(inArray(conversation.id, conversationIds));
            return rows.length;
          },
          after: async (_sdk, { conversationIds, userId, collected }) => {
            after.push({ conversationIds: [...conversationIds].sort(), userId, collected });
            if (afterThrows) throw new Error("after failed");
          },
        },
      },
    },
  };
  return { plugin, before, after };
}

/** The core's delete of the user's Conversations `where` matches, committed, announced to the Host. */
async function deleteOwn(deps: TestDeps, userId: string, where?: SQL) {
  const { deleted, afterCommit } = await deps.db.transaction((tx) =>
    deleteConversations(deps, tx, { userId, where, announce: {} }),
  );
  await afterCommit();
  return deleted;
}

async function conversationExists(id: string) {
  const rows = await getTestDb().select().from(conversation).where(eq(conversation.id, id));
  return rows.length > 0;
}

/** A Bot of `owner`, with its own Conversation as the `bot` plugin makes it. Returns that Conversation's id. */
async function insertBotConversation(owner: TestUser): Promise<string> {
  const botConversation = await insertConversation(owner, { kind: "bot", model: null });
  await getTestDb().insert(bot).values({
    id: uuidv7(),
    userId: owner.id,
    conversationId: botConversation.id,
    name: "Ada",
    model: "anthropic:claude-sonnet-5-5",
  });
  return botConversation.id;
}

describe("the core's Conversation delete runs the delete hooks", () => {
  it("runs them for a user delete, with every Conversation of the user", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const ids = [(await insertConversation(user)).id, (await insertConversation(user)).id].sort();
    await insertConversation(other);
    const recorder = recordingPlugin();
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await deleteUserData(deps, user.id);

    expect(recorder.before).toEqual([{ conversationIds: ids, userId: user.id }]);
    expect(recorder.after).toEqual([{ conversationIds: ids, userId: user.id, collected: 2 }]);
  });

  it("runs them for a Bot's Conversation, which the bot plugin deletes on a user delete", async () => {
    const user = await insertUser();
    const botConversation = await insertBotConversation(user);
    const recorder = recordingPlugin();
    const deps = createTestSdk({ plugins: [botPlugin(), recorder.plugin] });

    await deleteUserData(deps, user.id);

    expect(recorder.before).toEqual([{ conversationIds: [botConversation], userId: user.id }]);
    expect(recorder.after).toEqual([
      { conversationIds: [botConversation], userId: user.id, collected: 1 },
    ]);
    expect(await conversationExists(botConversation)).toBe(false);
  });

  it("leaves no matching Conversation behind when one is committed between the select and the delete", async () => {
    const user = await insertUser();
    const first = await insertConversation(user);
    let late: string | undefined;
    const seen: string[][] = [];
    const plugin: BotSdkPlugin = {
      id: "racer",
      databaseHooks: {
        conversation: {
          delete: {
            before: async (_sdk, { conversationIds }) => {
              seen.push([...conversationIds]);
              // Another connection commits a Conversation for the user mid-delete.
              late ??= (await insertConversation(user)).id;
            },
            after: async () => {},
          },
        },
      },
    };
    const deps = createTestSdk({ plugins: [plugin] });

    await deleteOwn(deps, user.id);

    expect(await conversationExists(first.id)).toBe(false);
    expect(await conversationExists(late!)).toBe(false);
    // The late Conversation's hooks ran too, before it went.
    expect(seen).toEqual([[first.id], [late]]);
  });

  it("reports the Conversation deleted to only one of two concurrent deletes", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user);
    // Both deletes have selected the row before either deletes it.
    let arrived = 0;
    let release!: () => void;
    const bothSelected = new Promise<void>((resolve) => (release = resolve));
    const plugin: BotSdkPlugin = {
      id: "barrier",
      databaseHooks: {
        conversation: {
          delete: {
            before: async () => {
              arrived += 1;
              if (arrived === 2) release();
              await bothSelected;
            },
            after: async () => {},
          },
        },
      },
    };
    const onConversationDeleted = vi.fn();
    const deps = createTestSdk({
      plugins: [plugin],
      hooks: createHookEmitter({ onConversationDeleted }, { error: () => {} }),
    });

    const results = await Promise.all([
      deleteOwn(deps, user.id, eq(conversation.id, conv.id)),
      deleteOwn(deps, user.id, eq(conversation.id, conv.id)),
    ]);

    expect(results.map((deleted) => deleted.length).sort()).toEqual([0, 1]);
    await vi.waitFor(() => expect(onConversationDeleted).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onConversationDeleted).toHaveBeenCalledOnce();
  });

  it("gives the hooks muted events, `before` too, on a muted delete", async () => {
    const user = await insertUser();
    await insertConversation(user);
    const fire = (sdk: BotSdkContext, id: string) =>
      sdk.events.fire("onConversationDeleted", { userId: user.id, conversationId: id });
    const plugin: BotSdkPlugin = {
      id: "announcer",
      databaseHooks: {
        conversation: {
          delete: {
            before: async (sdk) => fire(sdk, "before"),
            after: async (sdk) => fire(sdk, "after"),
          },
        },
      },
    };
    const onConversationDeleted = vi.fn();
    const deps = createTestSdk({
      plugins: [plugin],
      hooks: createHookEmitter({ onConversationDeleted }, { error: () => {} }),
    });

    const { afterCommit } = await deps.db.transaction((tx) =>
      deleteConversations(deps, tx, { userId: user.id, mute: true }),
    );
    await afterCommit();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onConversationDeleted).not.toHaveBeenCalled();
  });

  it("runs no hook when there is nothing to delete", async () => {
    const user = await insertUser();
    const recorder = recordingPlugin();
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await deleteOwn(deps, user.id);

    expect(recorder.before).toEqual([]);
    expect(recorder.after).toEqual([]);
  });
});

describe("a delete hook that throws, on the core's delete", () => {
  it("rolls the delete back from `before`", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user);
    const recorder = recordingPlugin({ beforeThrows: true });
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await expect(deleteOwn(deps, user.id)).rejects.toThrow("before failed");

    expect(await conversationExists(conv.id)).toBe(true);
    expect(recorder.after).toEqual([]);
  });

  it("is logged from `after`, and the delete is kept", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user);
    const recorder = recordingPlugin({ afterThrows: true });
    const error = vi.fn();
    const deps = createTestSdk({ plugins: [recorder.plugin], logger: { error } });

    expect(await deleteOwn(deps, user.id)).toEqual([conv.id]);

    expect(await conversationExists(conv.id)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "after failed" }),
    );
  });
});
