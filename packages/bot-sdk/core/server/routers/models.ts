import { listAvailableModels } from "../chat/available-models";
import { protectedProcedure } from "../procedures";

export const modelsRouter = {
  /** The Models of Providers the caller has credentials for, and a new Conversation's default. */
  list: protectedProcedure.handler(({ context }) =>
    listAvailableModels(context.deps, context.user.id),
  ),
};
