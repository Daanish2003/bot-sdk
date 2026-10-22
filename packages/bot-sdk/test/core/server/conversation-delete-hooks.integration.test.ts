import { eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { deleteConversations } from "../../../core/server/chat/delete-conversations";
import { createHookEmitter, type RunEndEvent } from "../../../core/server/chat/hooks";
import { conversation, project } from "../../../core/server/db/schema";
import { uuidv7 } from "../../../core/server/lib/uuidv7";
import type { BotSdkContext, BotSdkPlugin } from "../../../core/server/plugin";
import { deleteConversation } from "../../../plugins/assistant/server/chat/store";
import { sweepExpiredTemporaryConversations } from "../../../plugins/assistant/server/chat/temporary";
import { deleteAllConversations } from "../../../plugins/assistant/server/delete-user";
import { deleteUserData } from "../../../core/server/user-data";
import { deleteProject } from "../../../plugins/assistant/server/project/store";
import { insertConversation, insertMessage } from "../../support/conversations";
import { createTestSdk } from "../../support/assistant";
import { getTestDb } from "../../support/test-database";
import { insertUser } from "../../support/users";

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

async function conversationExists(id: string) {
  const rows = await getTestDb().select().from(conversation).where(eq(conversation.id, id));
  return rows.length > 0;
}

const expired = () => new Date(Date.now() - 31 * 24 * 60 * 60_000);

describe("every path that deletes Conversations runs the delete hooks", () => {
  it("runs them for a single delete, with that Conversation", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user);
    await insertConversation(user);
    const recorder = recordingPlugin();
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await deleteConversation(deps, user.id, conv.id);

    expect(recorder.before).toEqual([{ conversationIds: [conv.id], userId: user.id }]);
    expect(recorder.after).toEqual([{ conversationIds: [conv.id], userId: user.id, collected: 1 }]);
  });

  it("runs them for a delete of all, with every Conversation of the user", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const ids = [(await insertConversation(user)).id, (await insertConversation(user)).id].sort();
    await insertConversation(other);
    const recorder = recordingPlugin();
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await deleteAllConversations(deps, user.id);

    expect(recorder.before).toEqual([{ conversationIds: ids, userId: user.id }]);
    expect(recorder.after).toEqual([{ conversationIds: ids, userId: user.id, collected: 2 }]);
  });

  it("runs them for the Temporary sweep, with no user", async () => {
    const user = await insertUser();
    const gone = await insertConversation(user, { temporary: true, lastMessageAt: expired() });
    const kept = await insertConversation(user, { temporary: true });
    const recorder = recordingPlugin();
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await sweepExpiredTemporaryConversations(deps);

    // The sweep spans users, so other tests' expired Conversations may be in the set too.
    expect(recorder.before).toHaveLength(1);
    expect(recorder.before[0]?.userId).toBeNull();
    expect(recorder.before[0]?.conversationIds).toContain(gone.id);
    expect(recorder.before[0]?.conversationIds).not.toContain(kept.id);
    expect(recorder.after[0]).toMatchObject({ userId: null });
    expect(recorder.after[0]?.conversationIds).toContain(gone.id);
  });

  it("runs them for a Project delete, with the Project's Conversations, before the Project goes", async () => {
    const user = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    const ids = [
      (await insertConversation(user, { projectId })).id,
      (await insertConversation(user, { projectId })).id,
    ].sort();
    await insertConversation(user);
    const recorder = recordingPlugin();
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await deleteProject(deps, user.id, projectId);

    expect(recorder.before).toEqual([{ conversationIds: ids, userId: user.id }]);
    // `collected: 2`: the hook still saw both Conversations, so the cascade from the Project didn't take them.
    expect(recorder.after).toEqual([{ conversationIds: ids, userId: user.id, collected: 2 }]);
  });

  it("runs them for a user delete, with every Conversation of the user", async () => {
    const user = await insertUser();
    const other = await insertUser();
    const projectId = uuidv7();
    await getTestDb().insert(project).values({ id: projectId, userId: user.id, name: "Thesis" });
    const ids = [
      (await insertConversation(user, { projectId })).id,
      (await insertConversation(user)).id,
    ].sort();
    await insertConversation(other);
    const recorder = recordingPlugin();
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await deleteUserData(deps, user.id);

    expect(recorder.before).toEqual([{ conversationIds: ids, userId: user.id }]);
    expect(recorder.after).toEqual([{ conversationIds: ids, userId: user.id, collected: 2 }]);
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

    await deleteAllConversations(deps, user.id);

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
      deleteConversation(deps, user.id, conv.id),
      deleteConversation(deps, user.id, conv.id),
    ]);

    expect(results.sort()).toEqual([false, true]);
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

    await deleteAllConversations(deps, user.id);

    expect(recorder.before).toEqual([]);
    expect(recorder.after).toEqual([]);
  });
});

describe("a delete hook that throws", () => {
  it("rolls the delete back from `before`", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user);
    const recorder = recordingPlugin({ beforeThrows: true });
    const deps = createTestSdk({ plugins: [recorder.plugin] });

    await expect(deleteConversation(deps, user.id, conv.id)).rejects.toThrow("before failed");

    expect(await conversationExists(conv.id)).toBe(true);
    expect(recorder.after).toEqual([]);
  });

  it("is logged from `after`, and the delete is kept", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user);
    const recorder = recordingPlugin({ afterThrows: true });
    const error = vi.fn();
    const deps = createTestSdk({ plugins: [recorder.plugin], logger: { error } });

    expect(await deleteConversation(deps, user.id, conv.id)).toBe(true);

    expect(await conversationExists(conv.id)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: "after failed" }),
    );
  });
});

describe("deleting a Conversation stops its live Runs", () => {
  /** A `streaming` reply whose owner stopped heartbeating an hour ago. */
  function orphanedReply(conversationId: string) {
    return insertMessage({
      conversationId,
      role: "assistant",
      text: "",
      status: "streaming",
      heartbeatAt: new Date(Date.now() - 60 * 60_000),
    });
  }

  it("on a single delete, firing onRunEnd after the commit", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user);
    const reply = await orphanedReply(conv.id);
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = createTestSdk({ hooks: createHookEmitter({ onRunEnd }, { error: () => {} }) });

    await deleteConversation(deps, user.id, conv.id);

    await vi.waitFor(() => expect(onRunEnd).toHaveBeenCalledTimes(1));
    expect(onRunEnd).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: reply.id, ending: "stopped" }),
    );
  });

  it("in the Temporary sweep, firing onRunEnd after the commit", async () => {
    const user = await insertUser();
    const conv = await insertConversation(user, { temporary: true, lastMessageAt: expired() });
    const reply = await orphanedReply(conv.id);
    const onRunEnd = vi.fn<(run: RunEndEvent) => void>();
    const deps = createTestSdk({ hooks: createHookEmitter({ onRunEnd }, { error: () => {} }) });

    await sweepExpiredTemporaryConversations(deps);

    await vi.waitFor(() =>
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: reply.id, ending: "stopped" }),
      ),
    );
  });
});
