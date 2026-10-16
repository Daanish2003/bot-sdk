import type { AppDeps } from "./deps";

/** The signed-in user, as the Host's `getUser` returns them. */
export type ChatUser = { id: string };

export type Context = {
  /** `null` only for the public Shared link read. */
  user: ChatUser | null;
  deps: AppDeps;
};
