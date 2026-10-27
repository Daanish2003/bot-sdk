import { modelsContract } from "@botsdk/client/models/contract";
import { implement } from "@orpc/server";

import type { Context } from "../../../../core/server/context";
import { requireAuth } from "../../../../core/server/procedures";
import { readQuota } from "../quota";
import { modelsDeps } from "../state";

const os = implement(modelsContract).$context<Context>().use(requireAuth);

/**
 * The `models` plugin's router: it implements the `models` contract (`shared/contract.ts`) over
 * `sdk.models`, with the signed-in user's id. Served under `<basePath>/rpc/models`.
 */
export const modelsPluginRouter = os.router({
  models: {
    list: os.models.list.handler(({ context }) =>
      context.sdk.models.list({ userId: context.user.id }),
    ),
    imageModel: os.models.imageModel.handler(({ context }) =>
      context.sdk.models.imageModel({ userId: context.user.id }),
    ),
    setImageModel: os.models.setImageModel.handler(({ context, input }) =>
      context.sdk.models.setImageModel({ ...input, userId: context.user.id }),
    ),
    credentials: {
      list: os.models.credentials.list.handler(({ context }) =>
        context.sdk.models.credentials.list({ userId: context.user.id }),
      ),
      openaiState: os.models.credentials.openaiState.handler(({ context }) =>
        context.sdk.models.credentials.openaiState({ userId: context.user.id }),
      ),
      mode: os.models.credentials.mode.handler(({ context }) => ({
        byok: context.sdk.models.byok,
      })),
      save: os.models.credentials.save.handler(({ context, input }) =>
        context.sdk.models.credentials.save({ ...input, userId: context.user.id }),
      ),
      delete: os.models.credentials.delete.handler(({ context, input }) =>
        context.sdk.models.credentials.delete({ ...input, userId: context.user.id }),
      ),
    },
    readQuota: os.models.readQuota.handler(({ context }) =>
      readQuota(modelsDeps(context), context.user.id),
    ),
  },
});
