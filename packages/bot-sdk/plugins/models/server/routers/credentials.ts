import { protectedProcedure } from "../../../../core/server/procedures";
import { saveCredentialsInput } from "../../shared/credentials/services";
import { deleteCredentialsInput } from "../models-domain";

/** Provider credentials and Tool credentials. Write-only: the client only ever sees hints (ADR 0003). */
export const credentialsRouter = {
  list: protectedProcedure.handler(({ context }) =>
    context.sdk.models.credentials.list({ userId: context.user.id }),
  ),

  /** The OpenAI row's state on the Keys page (`sdk.models.credentials.openaiState`, ADR 0023). */
  openaiState: protectedProcedure.handler(({ context }) =>
    context.sdk.models.credentials.openaiState({ userId: context.user.id }),
  ),

  /** Whether the user may bring their own Provider credentials (`byok`, ADR 0007). */
  mode: protectedProcedure.handler(({ context }) => ({ byok: context.sdk.models.byok })),

  save: protectedProcedure
    .input(saveCredentialsInput)
    .handler(({ context, input }) =>
      context.sdk.models.credentials.save({ ...input, userId: context.user.id }),
    ),

  delete: protectedProcedure
    .input(deleteCredentialsInput)
    .handler(({ context, input }) =>
      context.sdk.models.credentials.delete({ ...input, userId: context.user.id }),
    ),
};
