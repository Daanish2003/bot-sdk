import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { type DecideResult, decideApproval } from "../chat/approval";
import { stopRun } from "../chat/run";
import { findMessage } from "../chat/store";
import { protectedProcedure } from "../procedures";

const refusals: Record<Exclude<DecideResult, "started" | "not_found">, string> = {
  not_waiting: "The Message is not waiting for Approval",
  streaming: "A reply is still streaming in this Conversation",
  unavailable: "The Model can't resume this reply: its Model or credentials are unavailable",
  quota: "You've used this window's Quota",
};

/** Throws the error a decision that didn't start a Run is refused with. */
function refuseDecision(result: DecideResult): void {
  if (result === "started") return;
  if (result === "not_found") throw new ORPCError("NOT_FOUND", { message: "Message not found" });
  throw new ORPCError("CONFLICT", { message: refusals[result] });
}

export const chatRouter = {
  /**
   * Stops the run writing a streaming assistant Message (ADR 0002). The run saves it `stopped`
   * and the client just sees its stream close. A Message that already ended is left alone. Stop on
   * a Message waiting for Approval counts as a denial (ADR 0008), and a refused denial is an error.
   */
  stop: protectedProcedure
    .input(z.object({ messageId: z.uuid() }))
    .handler(async ({ context, input }) => {
      const owned = await findMessage(context.deps, context.user.id, input.messageId);
      if (!owned) throw new ORPCError("NOT_FOUND", { message: "Message not found" });
      if (owned.status === "awaiting_approval") {
        refuseDecision(await decideApproval(context.deps, context.user.id, owned.id, false));
        return;
      }
      await stopRun(context.deps, owned.id);
    }),
  /**
   * Answers the call a reply is waiting on (ADR 0008): approve runs it, deny refuses it. With
   * `allowForConversation` (approve only) the call's tool also runs without Approval for the rest
   * of the Conversation (#159). The reply continues in a new Run on the same Message; join it from
   * its log to follow it.
   */
  decide: protectedProcedure
    .input(
      z.object({
        messageId: z.uuid(),
        approved: z.boolean(),
        allowForConversation: z.boolean().optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      refuseDecision(
        await decideApproval(
          context.deps,
          context.user.id,
          input.messageId,
          input.approved,
          input.allowForConversation,
        ),
      );
    }),
};
