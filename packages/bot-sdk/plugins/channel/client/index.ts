import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { ChannelRouter } from "../../bot/server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    channel: ChannelRouter;
  }
}

export type ChannelClientPlugin = BotSdkClientPlugin<"channel", ChannelRouter>;

/** The `channel` plugin's client: its router is `channel`. It adds no URLs. */
export function channelClient(): ChannelClientPlugin {
  return { id: "channel" };
}
