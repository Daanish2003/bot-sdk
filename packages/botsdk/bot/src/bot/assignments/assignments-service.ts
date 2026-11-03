import type { AssignmentResult, AssignmentStatus } from "@botsdk/client/bot/assignment";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { AnyFeature } from "../../feature";
import type { BotSdkContext, Transaction } from "../../plugin";
import { parseInput, rpcError } from "../../rpc-error";
import type { JobDefinition } from "../../runner/internal";
import { bot, botAssignment } from "../../storage";
import { hintChanged } from "../conversation";
import { lockConversation } from "../triggers";
import {
  assignmentInstructionsInput,
  assignmentTitleInput,
  cancelAssignment,
  canWork,
  moveAssignment,
  openAssignment,
} from "./assignment";

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
  title: assignmentTitleInput,
  instructions: assignmentInstructionsInput,
});

const assignmentInput = z.object({ id: z.uuid() });

const moveInput = z.object({ id: z.uuid(), botId: z.uuid() });

/** What a feature's `needs: ["assignments"]` gives it. */
export type AssignmentsService = {
  /**
   * Hands work to one of the owner's Bots, as untrusted text: the Bot weighs it, and neither it nor
   * Auto-review ever takes it as the user's word. `job` is one of the feature's `jobs`, queued in the
   * transaction that ends the Assignment. Another user's Bot is NOT_FOUND, and a Bot whose Model
   * can't run is CONFLICT.
   *
   * It runs in the caller's transaction, so a job step's Checkpoint commits with it and a replay
   * never makes a second one. A refusal comes before anything is written, so the caller may catch it
   * and commit. It takes the Conversation's lock, so any lock of the caller's that others take before
   * a Conversation's comes first. The caller wakes the runner and hints `conversationId` once `tx`
   * commits.
   */
  create: (
    tx: Transaction,
    input: {
      userId: string;
      botId: string;
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
};

const notFound = () => rpcError("NOT_FOUND", "error.assignmentNotFound", "Assignment not found");

/** The `assignments` service `feature` gets. */
export function assignmentsService(deps: BotSdkContext, feature: AnyFeature): AssignmentsService {
  return {
    create: async (tx, { userId, job, ...rest }) => {
      const { botId, ...work } = parseInput(createInput, rest);
      if (!feature.jobs?.some((own) => own.name === job.name)) {
        throw new Error(`The job "${job.name}" isn't one of feature "${feature.id}"'s jobs`);
      }
      const [target] = await tx
        .select({ id: bot.id, model: bot.model, conversationId: bot.conversationId })
        .from(bot)
        .where(and(eq(bot.id, botId), eq(bot.userId, userId)));
      if (!target) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      if (!(await canWork(deps, { userId, model: target.model }))) {
        throw rpcError("CONFLICT", "error.assignmentBotCantWork", "The Bot can't work right now");
      }
      await lockConversation(tx, target.conversationId);
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
        work,
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
  };
}
