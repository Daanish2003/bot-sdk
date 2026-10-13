import { z } from "zod";

import { instructionsMaxChars } from "../../shared/chat/instructions";
import { isKnownModel } from "../../shared/chat/models";
import { protectedProcedure } from "../procedures";
import { rpcError } from "../rpc-error";
import { loadSettings, saveInstructions, saveBackgroundModel } from "../settings/store";

export const settingsRouter = {
  get: protectedProcedure.handler(({ context }) => loadSettings(context.deps, context.user.id)),

  /**
   * Chooses the Model that writes automatic titles; `null` is "Same as first reply". Credentials
   * aren't required: without them, titles fall back to the start of the first Message.
   */
  setBackgroundModel: protectedProcedure
    .input(z.object({ backgroundModel: z.string().nullable() }))
    .handler(async ({ context, input }) => {
      if (input.backgroundModel !== null && !isKnownModel(input.backgroundModel)) {
        throw rpcError(
          "BAD_REQUEST",
          "error.modelNotAvailable",
          `"${input.backgroundModel}" is not an available Model`,
          {
            model: input.backgroundModel,
          },
        );
      }
      await saveBackgroundModel(context.deps, context.user.id, input.backgroundModel);
    }),

  /** Saves the Instructions sent with every Run from the next one; blank or `null` clears them. */
  setInstructions: protectedProcedure
    .input(z.object({ instructions: z.string().nullable() }))
    .handler(async ({ context, input }) => {
      if (input.instructions !== null && input.instructions.length > instructionsMaxChars) {
        throw rpcError(
          "BAD_REQUEST",
          "error.instructionsTooLong",
          `Instructions are limited to ${instructionsMaxChars} characters`,
          {
            max: instructionsMaxChars,
          },
        );
      }
      await saveInstructions(context.deps, context.user.id, input.instructions);
    }),
};
