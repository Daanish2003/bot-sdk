import { readQuota, modelsDeps } from "../internal";
import { protectedProcedure } from "../../../../core/server/procedures";

export const quotaRouter = {
  /**
   * The caller's Quota on Host credentials: the used percentage, the window and its reset time,
   * never money. `null` when the Quota is unlimited (ADR 0007).
   */
  read: protectedProcedure.handler(({ context }) =>
    readQuota(modelsDeps(context), context.user.id),
  ),
};
