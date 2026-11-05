import type { AssignmentResult, AssignmentStatus } from "@botsdk/client/bot/assignment";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import type { AnyFeature } from "../../feature";
import type { BotSdkContext, Transaction } from "../../plugin";
import { parseInput, rpcError } from "../../rpc-error";
import type { JobDefinition } from "../../runner/internal";
import { bot, botAssignment, botTurn } from "../../storage";
import { hintChanged } from "../conversation";
import { lockConversationsInOrder } from "../triggers";
import {
  assignmentChainLimit,
  assignmentInstructionsInput,
  assignmentTitleInput,
  cancelAssignment,
  canWork,
  chainDepthFromTurn,
  moveAssignment,
  openAssignment,
} from "./assignment";
import { redactAssignments } from "./redact";

/*
 * The `assignments` core service (ticket #1185, ADR 0029): how a feature hands work to a Bot, as a
 * Representative will. One per feature, so it acts only on what that feature assigned, for the
 * owner it's called with. The core never calls a feature: the job it named tells it of the end.
 */

/** What the job an Assignment names is queued with when it ends: use it as the job's `payload`. */
export const assignmentEnded = z.object({
  assignmentId: z.uuid(),
  userId: z.string(),
  botId: z.uuid(),
  status: z.enum(["done", "failed", "cancelled"]),
  /** What the Bot finished it with, any Secret's value masked; null when it was cancelled. */
  result: z
    .object({
      outcome: z.string(),
      forCustomer: z.string().optional(),
      when: z.string().optional(),
    })
    .nullable(),
});

export type AssignmentEnded = z.infer<typeof assignmentEnded>;

const createInput = z.object({
  botId: z.uuid(),
  turnId: z.uuid().optional(),
  title: assignmentTitleInput,
  instructions: assignmentInstructionsInput,
});

const assignmentInput = z.object({ id: z.uuid() });

const moveInput = z.object({ id: z.uuid(), botId: z.uuid() });

const redactInput = z.object({ ids: z.array(z.uuid()) });

/** What a feature's `needs: ["assignments"]` gives it. */
export type AssignmentsService = {
  /**
   * Hands work to one of the owner's Bots, as untrusted text: the Bot weighs it, and neither it nor
   * Auto-review ever takes it as the user's word. `job` is one of the feature's `jobs`, queued in the
   * transaction that ends the Assignment. Another user's Bot is NOT_FOUND, and a Bot whose Model
   * can't run is CONFLICT.
   *
   * `turnId` is the Bot Turn that started the work: the `id` of the Turn a feature's `tools` and
   * `afterTurn` are called for, which a job they queue carries in its payload. The core places the
   * Assignment in that Turn's chain, so a Bot → feature → Bot loop stops where a Bot's own chain does:
   * past the limit is CONFLICT, in a message the Model can act on. A Turn that doesn't exist or isn't
   * this owner's is NOT_FOUND. With no Turn behind the work, as for a webhook or a Representative's
   * hand-off, it starts a chain at depth 1.
   *
   * In a feature's `tools`, the service in the `context` they're given counts from the Turn it's
   * called in by itself, so `turnId` can be left out. If a tool names another Turn too, the deeper of
   * the two counts, so naming one can't lower its depth, and it must be this owner's. A job has no
   * live Turn, so `turnId` is the only way it stays in the chain.
   *
   * It runs in the caller's transaction, so a job step's Checkpoint commits with it and a replay
   * never makes a second one. A refusal comes before anything is written, so the caller may catch it
   * and commit. It takes the Conversation's lock, and the 1:1's of the Bot of each Turn it counts
   * from, so any lock of the caller's that others take before a Conversation's comes first. The
   * caller wakes the runner and hints `conversationId` once `tx` commits.
   */
  create: (
    tx: Transaction,
    input: {
      userId: string;
      botId: string;
      turnId?: string;
      title: string;
      instructions: string;
      job: Pick<JobDefinition<AssignmentEnded>, "name" | "payload">;
    },
  ) => Promise<{ id: string; conversationId: string }>;
  /** One of the feature's own Assignments for this owner; any other is NOT_FOUND. */
  read: (input: { userId: string; id: string }) => Promise<{
    id: string;
    botId: string;
    title: string;
    status: AssignmentStatus;
    result: AssignmentResult | null;
    createdAt: Date;
    endedAt: Date | null;
  }>;
  /** Cancels one of the feature's own Assignments, which queues its job; an ended one is CONFLICT. */
  cancel: (input: { userId: string; id: string }) => Promise<void>;
  /**
   * Moves one of the feature's own Assignments that hasn't ended to another of the owner's Bots,
   * keeping its status and log: a log row is added, the old Bot's unread hand-over is skipped, and
   * the new Bot wakes on it. An ended one is CONFLICT; another owner's Assignment or Bot, or one
   * another feature made, is NOT_FOUND; a Bot whose Model can't run is CONFLICT.
   */
  move: (input: { userId: string; id: string; botId: string }) => Promise<void>;
  /**
   * Flags one of the feature's own Assignments overdue, in the caller's transaction: sets its
   * `overdueAt` to now. It's a flag, never a status, so the work goes on. `marked` is false when
   * it had ended, was already flagged, or isn't this owner's or this feature's, so only the first
   * call for an Assignment that is still open gets true.
   */
  markOverdue: (
    tx: Transaction,
    input: { userId: string; id: string },
  ) => Promise<{ marked: boolean }>;
  /**
   * Redacts the feature's own Assignments `ids` of this owner, as deleting whoever they came from
   * needs (ticket #1288): their text and everything the Bot's records hold of it go, for the child
   * Assignments too, and the Assignments stay as redacted records. One that hasn't ended is cancelled
   * with its children, so no Bot waits on it. Any other id is ignored, and repeating it changes nothing.
   *
   * It runs in the caller's transaction and takes the locks of the Conversations it writes to, up
   * front in id order, so any lock of the caller's that others take before a Conversation's comes
   * first. The caller wakes the runner and hints `conversationIds` once `tx` commits.
   */
  redact: (
    tx: Transaction,
    input: { userId: string; ids: string[] },
  ) => Promise<{ conversationIds: string[] }>;
};

const notFound = () => rpcError("NOT_FOUND", "error.assignmentNotFound", "Assignment not found");

/**
 * The `assignments` service `feature` gets. With `turnBehind`, the Turn its tools were listed for
 * (#1218), `create` always counts from that Turn, whatever its caller names.
 */
export function assignmentsService(
  deps: BotSdkContext,
  feature: AnyFeature,
  turnBehind?: string,
): AssignmentsService {
  return {
    create: async (tx, { userId, job, ...rest }) => {
      const { botId, turnId, ...work } = parseInput(createInput, rest);
      if (!feature.jobs?.some((own) => own.name === job.name)) {
        throw new Error(`The job "${job.name}" isn't one of feature "${feature.id}"'s jobs`);
      }
      const [target] = await tx
        .select({ id: bot.id, model: bot.model, conversationId: bot.conversationId })
        .from(bot)
        .where(and(eq(bot.id, botId), eq(bot.userId, userId)));
      if (!target) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      const turnIds = [...new Set([turnBehind, turnId])].filter((id) => id !== undefined);
      const turns = turnIds.length
        ? await tx
            .select({ id: botTurn.id, botId: botTurn.botId, conversationId: bot.conversationId })
            .from(botTurn)
            .innerJoin(bot, eq(bot.id, botTurn.botId))
            .where(and(inArray(botTurn.id, turnIds), eq(bot.userId, userId)))
        : [];
      if (turns.length < turnIds.length) {
        throw rpcError("NOT_FOUND", "error.turnNotFound", "Turn not found");
      }
      if (!(await canWork(deps, { userId, model: target.model }))) {
        throw rpcError("CONFLICT", "error.assignmentBotCantWork", "The Bot can't work right now");
      }
      await lockConversationsInOrder(tx, [
        target.conversationId,
        ...turns.map((turn) => turn.conversationId),
      ]);
      let depth = 1;
      for (const turn of turns) depth = Math.max(depth, await chainDepthFromTurn(tx, turn));
      if (depth > assignmentChainLimit) {
        throw rpcError(
          "CONFLICT",
          "error.assignmentChainTooDeep",
          `A chain of Assignments stops at ${assignmentChainLimit} deep, and this would go past ` +
            "that. Do the rest of the work yourself, or finish with what you have.",
          { limit: assignmentChainLimit },
        );
      }
      const id = await openAssignment(
        deps,
        tx,
        target,
        {
          assignerBotId: null,
          assignerName: null,
          assignerFeature: feature.id,
          assignerJob: job.name,
          assignerTrusted: false,
          log: { actor: "feature" },
        },
        { ...work, depth },
      );
      return { id, conversationId: target.conversationId };
    },

    read: async ({ userId, ...rest }) => {
      const { id } = parseInput(assignmentInput, rest);
      const [row] = await deps.db
        .select({
          id: botAssignment.id,
          botId: botAssignment.assignedBotId,
          title: botAssignment.title,
          status: botAssignment.status,
          result: botAssignment.result,
          createdAt: botAssignment.createdAt,
          endedAt: botAssignment.endedAt,
        })
        .from(botAssignment)
        .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
        .where(
          and(
            eq(botAssignment.id, id),
            eq(botAssignment.assignerFeature, feature.id),
            eq(bot.userId, userId),
          ),
        );
      if (!row) throw notFound();
      return row;
    },

    cancel: async ({ userId, ...rest }) => {
      const { id } = parseInput(assignmentInput, rest);
      const cancelled = await deps.db.transaction((tx) =>
        cancelAssignment(deps, tx, { by: "feature", feature: feature.id, userId }, id),
      );
      if ("error" in cancelled) {
        throw cancelled.reason === "ended"
          ? rpcError("CONFLICT", "error.assignmentEnded", "This Assignment already ended")
          : notFound();
      }
      deps.runner.wake();
      for (const conversationId of cancelled.woken) await hintChanged(deps, conversationId);
    },

    move: async ({ userId, ...rest }) => {
      const { id, botId } = parseInput(moveInput, rest);
      const [target] = await deps.db
        .select({
          id: bot.id,
          name: bot.name,
          model: bot.model,
          conversationId: bot.conversationId,
        })
        .from(bot)
        .where(and(eq(bot.id, botId), eq(bot.userId, userId)));
      if (!target) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      if (!(await canWork(deps, { userId, model: target.model }))) {
        throw rpcError("CONFLICT", "error.assignmentBotCantWork", "The Bot can't work right now");
      }
      const moved = await deps.db.transaction((tx) =>
        moveAssignment(deps, tx, { feature: feature.id, userId }, id, target),
      );
      if ("reason" in moved) {
        throw moved.reason === "ended"
          ? rpcError("CONFLICT", "error.assignmentEnded", "This Assignment already ended")
          : notFound();
      }
      deps.runner.wake();
      for (const conversationId of moved.woken) await hintChanged(deps, conversationId);
    },

    markOverdue: async (tx, { userId, ...rest }) => {
      const { id } = parseInput(assignmentInput, rest);
      const [marked] = await tx
        .update(botAssignment)
        .set({ overdueAt: deps.clock() })
        .from(bot)
        .where(
          and(
            eq(bot.id, botAssignment.assignedBotId),
            eq(bot.userId, userId),
            eq(botAssignment.id, id),
            eq(botAssignment.assignerFeature, feature.id),
            isNull(botAssignment.overdueAt),
            isNull(botAssignment.endedAt),
          ),
        )
        .returning({ id: botAssignment.id });
      return { marked: marked !== undefined };
    },

    redact: async (tx, { userId, ...rest }) => {
      const { ids } = parseInput(redactInput, rest);
      const own = await tx
        .select({ id: botAssignment.id })
        .from(botAssignment)
        .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
        .where(
          and(
            inArray(botAssignment.id, ids),
            eq(botAssignment.assignerFeature, feature.id),
            eq(bot.userId, userId),
          ),
        );
      const conversationIds = await redactAssignments(deps, tx, {
        userId,
        ids: own.map((row) => row.id),
      });
      return { conversationIds };
    },
  };
}
