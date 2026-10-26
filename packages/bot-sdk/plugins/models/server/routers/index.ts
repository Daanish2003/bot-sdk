import { credentialsRouter } from "./credentials";
import { modelsRouter } from "./models";
import { quotaRouter } from "./quota";

/**
 * The `models` plugin's router: the `models` namespace, with the credentials nested
 * in it and `readQuota`, as `sdk.models` has them. Served under `<basePath>/rpc/models`.
 */
export const modelsPluginRouter = {
  models: { ...modelsRouter, credentials: credentialsRouter, readQuota: quotaRouter.read },
};
export type ModelsRouter = typeof modelsPluginRouter;
