import { credentialsRouter } from "./credentials";
import { modelsRouter } from "./models";
import { quotaRouter } from "./quota";
import { voiceRouter } from "./voice";

/** The `models` plugin's routers, served under `<basePath>/rpc/<key>`. */
export const modelsPluginRouter = {
  credentials: credentialsRouter,
  models: modelsRouter,
  quota: quotaRouter,
  voice: voiceRouter,
};
export type ModelsRouter = typeof modelsPluginRouter;
