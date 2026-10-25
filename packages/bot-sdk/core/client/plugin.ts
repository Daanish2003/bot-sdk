/**
 * The routers each part of the instance serves, by id. A client plugin adds itself by declaration
 * merging:
 * `declare module "…/plugin" { interface PluginRouters { models: ModelsRouter } }`.
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- extended by declaration merging
export interface PluginRouters {}

/**
 * A client plugin of the Bot SDK (ADR 0020): the id of the server plugin it pairs with, the URLs it
 * adds to the client, and, as a type only, the routers that plugin serves.
 */
export type BotSdkClientPlugin<Id extends string = string, Router = unknown> = {
  id: Id;
  /** Type only: the plugin's routers, which type the client's `rpc`. */
  readonly "~router"?: Router;
  /** The plugin's URLs on the client, from the base URL the Host mounted the handler at. */
  urls?: (base: string) => object;
};
