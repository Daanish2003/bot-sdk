import type { BotSdkContext } from "./plugin";

/** The signed-in user, as the Host's `getUser` returns them. */
export type ChatUser = { id: string };

export type Context = {
  /** Never `null` in a procedure: the handler answers 401 first, and `protectedProcedure` checks. */
  user: ChatUser | null;
  /** The core context; a plugin's procedures reach their own plugin through `sdk.plugin(id)`. */
  sdk: BotSdkContext;
};
