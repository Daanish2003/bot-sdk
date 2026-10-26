import { defineWebSocketHandler } from "nitro";

import { screenSocket } from "../../../../../../src/services";

/**
 * The live view's socket (#597), the Bot SDK's crossws hooks at `<basePath>/screens/<view token>/websockify`:
 * the one route of the SDK's HTTP layer that the fetch handler at /api/chat can't serve. No sign-in:
 * the view token in the path is the authentication, and an upgrade without a valid one gets 403.
 */
export default defineWebSocketHandler(screenSocket);
