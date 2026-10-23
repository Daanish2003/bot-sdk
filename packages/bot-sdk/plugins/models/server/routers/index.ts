import { credentialsRouter } from "./credentials";
import { modelsRouter } from "./models";
import { quotaRouter } from "./quota";

/** The `models` plugin's routers, served under `<basePath>/rpc/<key>`. */
export const modelsPluginRouter = {
  credentials: credentialsRouter,
  models: modelsRouter,
  quota: quotaRouter,
};
export type ModelsRouter = typeof modelsPluginRouter;
