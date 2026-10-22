import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { BotRouter } from "../server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    bot: BotRouter;
  }
}

export type BotClientPlugin = BotSdkClientPlugin<"bot", BotRouter>;

/** The `bot` plugin's client: its router is `bot`. It adds no URLs. */
export function botClient(): BotClientPlugin {
  return { id: "bot" };
}

export {
  botMessagePartsSchema,
  type RichControl,
  type RichControlKind,
  richControlJsonSchema,
  richControlSchema,
} from "../shared/rich-control";
