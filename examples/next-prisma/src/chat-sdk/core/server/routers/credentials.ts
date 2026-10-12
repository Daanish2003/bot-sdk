import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { checkCredentials } from "../credentials/check";
import {
  credentialHint,
  credentialServices,
  saveCredentialsInput,
} from "../../shared/credentials/services";
import { deleteCredentials, listCredentials, saveCredentials } from "../credentials/store";
import { protectedProcedure } from "../procedures";

/** Provider credentials and Tool credentials. Write-only: the client only ever sees hints (ADR 0003). */
export const credentialsRouter = {
  list: protectedProcedure.handler(({ context }) => listCredentials(context.deps, context.user.id)),

  /** Whether the user may bring their own Provider credentials (`byok`, ADR 0007). */
  mode: protectedProcedure.handler(({ context }) => ({ byok: context.deps.byok })),

  save: protectedProcedure.input(saveCredentialsInput).handler(async ({ context, input }) => {
    if (!context.deps.byok) {
      throw new ORPCError("FORBIDDEN", { message: "Your own keys are turned off on this app" });
    }
    // The user's Ollama host is not guarded (see `AppDeps.ollamaFetch`).
    const fetch = input.service === "ollama" ? context.deps.ollamaFetch : context.deps.fetch;
    const result = await checkCredentials(input.service, input.fields, fetch);
    if (result.status === "rejected") {
      throw new ORPCError("BAD_REQUEST", {
        message: result.message,
        data: { reason: result.reason },
      });
    }
    const summary = {
      service: input.service,
      hint: credentialHint(input.fields),
      verified: result.status === "verified",
    };
    await saveCredentials(context.deps, context.user.id, {
      ...summary,
      fields: input.fields,
    });
    return summary;
  }),

  delete: protectedProcedure
    .input(z.object({ service: z.enum(credentialServices) }))
    .handler(async ({ context, input }) => {
      await deleteCredentials(context.deps, context.user.id, input.service);
    }),
};
