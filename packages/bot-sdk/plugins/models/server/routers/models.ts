import { listAvailableModels } from "../available-models";
import { protectedProcedure } from "../../../../core/server/procedures";
import { modelsDeps } from "../state";

export const modelsRouter = {
  /** The Models of Providers the caller has credentials for, and a new Conversation's default. */
  list: protectedProcedure.handler(({ context }) =>
    listAvailableModels(modelsDeps(context), context.user.id),
  ),
};
