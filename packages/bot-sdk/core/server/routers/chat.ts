import { z } from "zod";

import { type DecideResult, decideApproval } from "../chat/approval";
import { stopRun } from "../chat/run";
import { findMessage, rateMessage } from "../chat/store";
import { protectedProcedure } from "../procedures";
import { rpcError } from "../rpc-error";

const refusals = {
  not_waiting: ["error.decisionNotWaiting", "The Message is not waiting for Approval"],
  streaming: ["error.replyStreaming", "A reply is still streaming in this Conversation"],
  unavailable: [
    "error.modelCannotResume",
    "The Model can't resume this reply: its Model or credentials are unavailable",
  ],
  quota: ["error.quotaSpent", "You've used this window's Quota"],
} as const;

/** Throws the error a decision that didn't start a Run is refused with. */
function refuseDecision(result: DecideResult): void {
  if (result === "started") return;
  if (result === "not_found") {
    throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
  }
  const [code, message] = refusals[result];
  throw rpcError("CONFLICT", code, message);
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
      if (!owned) throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
      if (owned.status === "awaiting_approval") {
        refuseDecision(await decideApproval(context.deps, context.user.id, owned.id, false));
        return;
      }
      for (const run of await stopRun(context.deps, owned.id)) {
        context.deps.hooks.fire("onRunEnd", run);
      }
    }),
  /**
   * Sets the owner's Rating of an ended assistant reply, `up` or `down`, or clears it with null
   * (CONTEXT.md, **Rating**). Only the latest is kept. Never sent to a Provider, nor on a Shared link.
   */
  rate: protectedProcedure
    .input(z.object({ messageId: z.uuid(), rating: z.enum(["up", "down"]).nullable() }))
    .handler(async ({ context, input }) => {
      const result = await rateMessage(
        context.deps,
        context.user.id,
        input.messageId,
        input.rating,
      );
      if (result === "not_found")
        throw rpcError("NOT_FOUND", "error.messageNotFound", "Message not found");
      if (result === "not_assistant") {
        throw rpcError(
          "BAD_REQUEST",
          "error.rateNotAssistant",
          "Only an assistant Message can be rated",
        );
      }
      if (result === "hidden") {
        throw rpcError("CONFLICT", "error.rateHidden", "A hidden reply can't be rated");
      }
      if (result === "live") {
        throw rpcError(
          "CONFLICT",
          "error.rateLive",
          "The reply can be rated once its Run has ended",
        );
      }
    }),
  /**
   * Answers the call a reply is waiting on (ADR 0008): approve runs it, deny refuses it. With
   * `allowForConversation` (approve only) the call's tool also runs without Approval for the rest
   * of the Conversation (#159). `webSearch` is the user's web search choice, as on a send. The
   * reply continues in a new Run on the same Message; join it from its log to follow it.
   */
  decide: protectedProcedure
    .input(
      z.object({
        messageId: z.uuid(),
        approved: z.boolean(),
        allowForConversation: z.boolean().optional(),
        webSearch: z.boolean().optional(),
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
          input.webSearch,
        ),
      );
    }),
};
