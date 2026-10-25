import { listAvailableModels, modelsDeps } from "../internal";
import { protectedProcedure } from "../../../../core/server/procedures";
import { z } from "zod";

import { rpcError } from "../../../../core/server/rpc-error";

export const modelsRouter = {
  /** The Models of Providers the caller has credentials for, and a new Conversation's default. */
  list: protectedProcedure.handler(({ context }) =>
    listAvailableModels(modelsDeps(context), context.user.id),
  ),

  /** The user's Image Model pick, or `null` for the Host's default. */
  imageModel: protectedProcedure.handler(async ({ context }) => ({
    imageModel: await context.sdk.models.imageModelSetting(context.user.id),
  })),

  /**
   * Chooses the Image Model Generated images are made with; `null` is the Host's default. The
   * Model must be one the user can use: a curated Image Model of a Provider they have credentials
   * for, or one of the Host's Image Models (spec #278).
   */
  setImageModel: protectedProcedure
    .input(z.object({ imageModel: z.string().nullable() }))
    .handler(async ({ context, input }) => {
      const models = context.sdk.models;
      if (
        input.imageModel !== null &&
        !(await models.resolveImageModel(context.user.id, input.imageModel))
      ) {
        throw rpcError(
          "BAD_REQUEST",
          "error.imageModelNotAvailable",
          `"${input.imageModel}" is not an available Image Model`,
          { model: input.imageModel },
        );
      }
      await models.saveImageModelSetting(context.user.id, input.imageModel);
    }),
};
