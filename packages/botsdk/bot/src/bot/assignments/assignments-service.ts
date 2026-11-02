import { and, eq, notInArray } from "drizzle-orm";
import { z } from "zod";

import type { AnyFeature } from "../../feature";
import type { BotSdkContext, Transaction } from "../../plugin";
import { parseInput, rpcError } from "../../rpc-error";
import type { JobDefinition } from "../../runner/internal";
import { bot, botAssignment } from "../../storage";
import { hintChanged, recordBotChange } from "../conversation";
import { webhookBodyLimit } from "../routines";
import { lockConversation } from "../triggers";
import {
  assignmentInstructionsInput,
  assignmentTitleInput,
  canWork,
  endedStatuses,
  logStatus,
  openAssignment,
  queueAssignerJob,
  withdrawFromBot,
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
  /** What the Bot finished it with; null when it was cancelled. */
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
  // A feature's text is capped as a webhook's is (ADR 0021): it is untrusted, and the Bot reads it.
  instructions: assignmentInstructionsInput.refine(
    (text) => new TextEncoder().encode(text).byteLength <= webhookBodyLimit,
    "instructions must be at most 64 KB",
  ),
});

const assignmentInput = z.object({ id: z.uuid() });

/** What a feature's `needs: ["assignments"]` gives it. */
export type AssignmentsService = {
  /**
   * Hands work to one of the owner's Bots, as untrusted text: the Bot weighs it, and neither it nor
   * Auto-review ever takes it as the user's word. `job` is one of the feature's `jobs`, queued in the
   * transaction that ends the Assignment. Another user's Bot is NOT_FOUND, and a Bot whose Model
   * can't run is CONFLICT.
   */
  create: (input: {
    userId: string;
    botId: string;
    title: string;
    instructions: string;
    job: Pick<JobDefinition<AssignmentEnded>, "name" | "payload">;
  }) => Promise<{ id: string }>;
  /** One of the feature's own Assignments for this owner; any other is NOT_FOUND. */
  read: (input: { userId: string; id: string }) => Promise<{
    id: string;
    botId: string;
    title: string;
    status: typeof botAssignment.$inferSelect.status;
    result: typeof botAssignment.$inferSelect.result;
    createdAt: Date;
    endedAt: Date | null;
  }>;
  /** Cancels one of the feature's own Assignments, which queues its job; an ended one is CONFLICT. */
  cancel: (input: { userId: string; id: string }) => Promise<void>;
};

/** The rows the feature can see, of this owner: every read and write here goes through it. */
const ownedBy = (feature: AnyFeature, userId: string, id: string) =>
  and(
    eq(botAssignment.id, id),
    eq(botAssignment.assignerFeature, feature.id),
    eq(bot.userId, userId),
  );

const notFound = () => rpcError("NOT_FOUND", "error.assignmentNotFound", "Assignment not found");

/** The `assignments` service `feature` gets. */
export function assignmentsService(deps: BotSdkContext, feature: AnyFeature): AssignmentsService {
  return {
    create: async ({ userId, job, ...rest }) => {
      const { botId, ...work } = parseInput(createInput, rest);
      if (!feature.jobs?.some((own) => own.name === job.name)) {
        throw new Error(`The job "${job.name}" isn't one of feature "${feature.id}"'s jobs`);
      }
      const [target] = await deps.db
        .select({ id: bot.id, model: bot.model, conversationId: bot.conversationId })
        .from(bot)
        .where(and(eq(bot.id, botId), eq(bot.userId, userId)));
      if (!target) throw rpcError("NOT_FOUND", "error.botNotFound", "Bot not found");
      if (!(await canWork(deps, { userId, model: target.model }))) {
        throw rpcError("CONFLICT", "error.assignmentBotCantWork", "The Bot can't work right now");
      }
      const id = await deps.db.transaction(async (tx) => {
        await lockConversation(tx, target.conversationId);
        return openAssignment(
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
      });
      deps.runner.wake();
      await hintChanged(deps, target.conversationId);
      return { id };
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
        .where(ownedBy(feature, userId, id));
      if (!row) throw notFound();
      return row;
    },

    cancel: async ({ userId, ...rest }) => {
      const { id } = parseInput(assignmentInput, rest);
      const conversationId = await deps.db.transaction((tx) =>
        cancelOwn(deps, tx, feature, userId, id),
      );
      deps.runner.wake();
      await hintChanged(deps, conversationId);
    },
  };
}

/** Ends the feature's Assignment as `cancelled`, in `tx`, and withdraws it from its Bot. */
async function cancelOwn(
  deps: BotSdkContext,
  tx: Transaction,
  feature: AnyFeature,
  userId: string,
  id: string,
): Promise<string> {
  const [row] = await tx
    .select({
      title: botAssignment.title,
      botId: botAssignment.assignedBotId,
      job: botAssignment.assignerJob,
      model: bot.model,
      conversationId: bot.conversationId,
    })
    .from(botAssignment)
    .innerJoin(bot, eq(bot.id, botAssignment.assignedBotId))
    .where(ownedBy(feature, userId, id));
  if (!row) throw notFound();
  const tells = await canWork(deps, { userId, model: row.model });
  await lockConversation(tx, row.conversationId);
  const now = deps.clock();
  const updated = await tx
    .update(botAssignment)
    .set({ status: "cancelled", updatedAt: now, endedAt: now })
    .where(and(eq(botAssignment.id, id), notInArray(botAssignment.status, endedStatuses)))
    .returning({ id: botAssignment.id });
  if (updated.length === 0) {
    throw rpcError("CONFLICT", "error.assignmentEnded", "This Assignment already ended");
  }
  await logStatus(tx, { assignmentId: id, status: "cancelled", actor: "feature", at: now });
  await withdrawFromBot(deps, tx, { ...row, id, feature: feature.id }, tells, now);
  await recordBotChange(tx, { conversationId: row.conversationId }, "assignment", id, now);
  await queueAssignerJob(deps, tx, row.job, {
    assignmentId: id,
    userId,
    botId: row.botId,
    status: "cancelled",
    result: null,
  });
  return row.conversationId;
}
