import type { AppDeps } from "./deps";
import type { BotSdkContext } from "./plugin";

/** The signed-in user, as the Host's `getUser` returns them. */
export type ChatUser = { id: string };

export type Context = {
  /** `null` only for the public Shared link read. */
  user: ChatUser | null;
  /** The assistant's bundle; unset on an instance without the assistant (until #444). */
  deps: AppDeps;
  /** The instance's plugin APIs: how a plugin's procedures reach their own plugin. */
  plugin: BotSdkContext["plugin"];
};
