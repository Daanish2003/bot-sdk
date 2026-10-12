import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { instructionsMaxChars } from "../../shared/chat/instructions";
import { isKnownModel } from "../../shared/chat/models";
import { protectedProcedure } from "../procedures";
import { loadSettings, saveInstructions, saveTitleModel } from "../settings/store";

export const settingsRouter = {
  get: protectedProcedure.handler(({ context }) => loadSettings(context.deps, context.user.id)),

  /**
   * Chooses the Model that writes automatic titles; `null` is "Same as first reply". Credentials
   * aren't required: without them, titles fall back to the start of the first Message.
   */
  setTitleModel: protectedProcedure
    .input(z.object({ titleModel: z.string().nullable() }))
    .handler(async ({ context, input }) => {
      if (input.titleModel !== null && !isKnownModel(input.titleModel)) {
        throw new ORPCError("BAD_REQUEST", {
          message: `"${input.titleModel}" is not an available Model`,
        });
      }
      await saveTitleModel(context.deps, context.user.id, input.titleModel);
    }),

  /** Saves the Instructions sent with every Run from the next one; blank or `null` clears them. */
  setInstructions: protectedProcedure
    .input(z.object({ instructions: z.string().nullable() }))
    .handler(async ({ context, input }) => {
      if (input.instructions !== null && input.instructions.length > instructionsMaxChars) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Instructions are limited to ${instructionsMaxChars.toLocaleString("en-US")} characters`,
        });
      }
      await saveInstructions(context.deps, context.user.id, input.instructions);
    }),
};
