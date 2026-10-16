import type { BotSdkPlugin } from "../../../core/server/plugin";
import { botPluginRouter } from "./routers/index";
import { botUserDelete, exportBots } from "./store";

export type BotPlugin = BotSdkPlugin<"bot", never, never>;

/**
 * The `bot` plugin (ADR 0020): always-on Bots, each a name and a Model talking to its user in one
 * Conversation of kind `bot`.
 */
export function bot(): BotPlugin {
  return {
    id: "bot",
    requires: ["models"],
    router: botPluginRouter,
    deleteUser: botUserDelete,
    exportUser: (_sdk, userId, tx) => exportBots(tx, userId),
  };
}
