import { protectedProcedure } from "../../../../core/server/procedures";
import { setImageModelInput } from "../models-domain";

export const modelsRouter = {
  /** The Models of Providers the caller has credentials for, and a new Conversation's default. */
  list: protectedProcedure.handler(({ context }) =>
    context.sdk.models.list({ userId: context.user.id }),
  ),

  /** The user's Image Model pick, or `null` for the Host's default. */
  imageModel: protectedProcedure.handler(({ context }) =>
    context.sdk.models.imageModel({ userId: context.user.id }),
  ),

  /**
   * Chooses the Image Model Generated images are made with (`sdk.models.setImageModel`); `null` is
   * the Host's default.
   */
  setImageModel: protectedProcedure
    .input(setImageModelInput)
    .handler(({ context, input }) =>
      context.sdk.models.setImageModel({ ...input, userId: context.user.id }),
    ),
};
