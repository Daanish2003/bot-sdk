import { z } from "zod";

import { instructionsMaxChars } from "../../shared/chat/instructions";
import { isKnownModel } from "../../../models/shared/models";
import { protectedProcedure } from "../../../../core/server/procedures";
import { rpcError } from "../../../../core/server/rpc-error";
import { loadSettings, saveInstructions, saveBackgroundModel } from "../settings/store";

export const settingsRouter = {
  /** The user's settings, with the Image Model from the models plugin's `model_settings` (spec #801). */
  get: protectedProcedure.handler(async ({ context }) => ({
    ...(await loadSettings(context.sdk, context.user.id)),
    imageModel: await context.sdk.plugin("models").imageModelSetting(context.user.id),
  })),

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
      await saveBackgroundModel(context.sdk, context.user.id, input.backgroundModel);
    }),

  /**
   * Chooses the Image Model Generated images are made with; `null` is the Host's default. The
   * Model must be one the user can use: a curated Image Model of a Provider they have credentials
   * for, or one of the Host's Image Models (spec #278).
   */
  setImageModel: protectedProcedure
    .input(z.object({ imageModel: z.string().nullable() }))
    .handler(async ({ context, input }) => {
      if (
        input.imageModel !== null &&
        !(await context.sdk.plugin("models").resolveImageModel(context.user.id, input.imageModel))
      ) {
        throw rpcError(
          "BAD_REQUEST",
          "error.imageModelNotAvailable",
          `"${input.imageModel}" is not an available Image Model`,
          { model: input.imageModel },
        );
      }
      await context.sdk.plugin("models").saveImageModelSetting(context.user.id, input.imageModel);
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
      await saveInstructions(context.sdk, context.user.id, input.instructions);
    }),
};
