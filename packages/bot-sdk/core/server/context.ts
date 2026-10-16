import type { BotSdkContext } from "./plugin";

/** The signed-in user, as the Host's `getUser` returns them. */
export type ChatUser = { id: string };

export type Context = {
  /** `null` only for the public Shared link read. */
  user: ChatUser | null;
  /** The core context; a plugin's procedures reach their own plugin through `sdk.plugin(id)`. */
  sdk: BotSdkContext;
};
