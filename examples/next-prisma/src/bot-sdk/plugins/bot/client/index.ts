import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { BotRouter } from "../server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    bot: BotRouter;
  }
}

declare module "../../../core/client/chat-client" {
  /** The URLs the bot plugin adds to the client. */
  interface BotSdkClient {
    /** A file the Bot sent, by id (`GET <botFilesUrl>/<id>`), a download; add `/inline` to show an image. */
    botFilesUrl: string;
  }
}

export type BotClientPlugin = BotSdkClientPlugin<"bot", BotRouter> & {
  urls: (base: string) => { botFilesUrl: string };
};

/** The `bot` plugin's client: its router is `bot`, and it adds the URL of the files a Bot sent. */
export function botClient(): BotClientPlugin {
  return { id: "bot", urls: (base) => ({ botFilesUrl: `${base}/bot-files` }) };
}

export {
  botMessagePartsSchema,
  type RichControl,
  type RichControlKind,
  richControlJsonSchema,
  richControlSchema,
} from "../shared/rich-control";
