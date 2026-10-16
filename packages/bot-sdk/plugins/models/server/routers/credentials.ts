import { z } from "zod";

import { checkCredentials } from "../credentials/check";
import {
  credentialHint,
  credentialServices,
  saveCredentialsInput,
} from "../../shared/credentials/services";
import { deleteCredentials, listCredentials, saveCredentials } from "../credentials/store";
import { protectedProcedure } from "../../../../core/server/procedures";
import { modelsDeps } from "../state";
import { rpcError } from "../../../../core/server/rpc-error";

/** Provider credentials and Tool credentials. Write-only: the client only ever sees hints (ADR 0003). */
export const credentialsRouter = {
  list: protectedProcedure.handler(({ context }) =>
    listCredentials(modelsDeps(context), context.user.id),
  ),

  /** Whether the user may bring their own Provider credentials (`byok`, ADR 0007). */
  mode: protectedProcedure.handler(({ context }) => ({ byok: modelsDeps(context).byok })),

  save: protectedProcedure.input(saveCredentialsInput).handler(async ({ context, input }) => {
    const deps = modelsDeps(context);
    if (!deps.byok) {
      throw rpcError("FORBIDDEN", "error.byokOff", "Your own keys are turned off on this app");
    }
    // The user's Ollama host is not guarded (see `ModelsDeps.ollamaFetch`).
    const fetch = input.service === "ollama" ? deps.ollamaFetch : deps.fetch;
    const result = await checkCredentials(input.service, input.fields, fetch);
    if (result.status === "rejected") {
      throw rpcError("BAD_REQUEST", result.code, result.message, result.params, {
        reason: result.reason,
      });
    }
    const summary = {
      service: input.service,
      hint: credentialHint(input.fields),
      verified: result.status === "verified",
    };
    await saveCredentials(deps, context.user.id, {
      ...summary,
      fields: input.fields,
    });
    return summary;
  }),

  delete: protectedProcedure
    .input(z.object({ service: z.enum(credentialServices) }))
    .handler(async ({ context, input }) => {
      await deleteCredentials(modelsDeps(context), context.user.id, input.service);
    }),
};
