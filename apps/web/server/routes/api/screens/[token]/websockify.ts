import { defineWebSocketHandler } from "nitro";

import { sdk } from "../../../../../src/services";

/**
 * The live view's socket (#597): the Bot SDK joins it to the Screen's websockify, adding the traffic
 * token server-side. No sign-in: the view token in the path is the authentication, and an upgrade
 * without a valid one is refused with 403.
 */
export default defineWebSocketHandler(sdk.bot.screenSocket);
