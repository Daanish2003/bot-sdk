import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { ModelsRouter } from "../server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    models: ModelsRouter;
  }
}

export type ModelsClientPlugin = BotSdkClientPlugin<"models", ModelsRouter>;

/** The `models` plugin's client: its routers are `credentials`, `models`, `quota` and `voice`. */
export function modelsClient(): ModelsClientPlugin {
  return { id: "models" };
}
