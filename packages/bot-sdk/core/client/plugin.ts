/**
 * A client plugin of the Bot SDK (ADR 0020): the id of the server plugin it pairs with, and, as a
 * type only, the routers that plugin serves.
 */
export type BotSdkClientPlugin<Id extends string = string, Router = unknown> = {
  id: Id;
  /** Type only: the plugin's routers, which type the client's `rpc`. */
  readonly "~router"?: Router;
};
