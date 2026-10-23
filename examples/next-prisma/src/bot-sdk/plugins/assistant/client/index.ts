import type { BotSdkClient } from "../../../core/client/chat-client";
import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import type { AppRouter } from "../server/routers/index";

declare module "../../../core/client/plugin" {
  interface PluginRouters {
    assistant: AppRouter;
  }
}

declare module "../../../core/client/chat-client" {
  /** The URLs the assistant adds to the client. */
  interface BotSdkClient {
    /** Where a Run is posted (`POST`) and joined (`GET ?runId=`). */
    chatUrl: string;
    /** A Generated image's bytes, by id (`GET <generatedImagesUrl>/<id>`, `?download=1` to save). */
    generatedImagesUrl: string;
    /** A Generated image on a Shared link, by its token and id (`GET <base>/shared/<token>/generated-images/<id>`). */
    sharedGeneratedImagesUrl: (token: string) => string;
  }
}

type AssistantUrls = Pick<
  BotSdkClient,
  "chatUrl" | "generatedImagesUrl" | "sharedGeneratedImagesUrl"
>;

export type AssistantClientPlugin = BotSdkClientPlugin<"assistant", AppRouter> & {
  urls: (base: string) => AssistantUrls;
};

/** The `assistant` plugin's client: its routers, and the URLs of its Runs and images. */
export function assistantClient(): AssistantClientPlugin {
  return {
    id: "assistant",
    urls: (base) => ({
      chatUrl: `${base}/run`,
      generatedImagesUrl: `${base}/generated-images`,
      sharedGeneratedImagesUrl: (token) => `${base}/shared/${token}/generated-images`,
    }),
  };
}
