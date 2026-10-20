import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { MemoryRouter } from "../server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    memory: MemoryRouter;
  }
}

export type MemoryClientPlugin = BotSdkClientPlugin<"memory", MemoryRouter>;

/** The `memory` plugin's client: its router is `memory`. It adds no URLs. */
export function memoryClient(): MemoryClientPlugin {
  return { id: "memory" };
}
