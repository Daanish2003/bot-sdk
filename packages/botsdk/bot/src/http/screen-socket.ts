import { screensPath } from "@botsdk/client/bot/helper";

import { httpPartsOf, type BotSdk } from "../create-chat";
import { screenSocketHooks, type ScreenSocketHooks } from "../bot/helpers";
import { serveAt } from "./handler";

/**
 * The live view's socket (#597) as WebSocket hooks in crossws's shape, the one route the fetch
 * handler can't serve: the Host mounts them at `<basePath>/screens/<view token>/websockify`, the
 * same `basePath` as `createHttpHandler`'s (Nitro: `defineWebSocketHandler(hooks)`; any crossws
 * adapter on Node, Bun, Deno or Cloudflare). No sign-in: the view token in the path is the
 * authentication, and an upgrade without a valid one is refused with 403.
 */
export function createScreenSocket(
  sdk: BotSdk,
  { basePath }: { basePath: string },
): ScreenSocketHooks {
  const { context } = httpPartsOf(sdk);
  return screenSocketHooks(context, screensPath(serveAt(context, basePath)));
}
