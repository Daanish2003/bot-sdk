import { chat } from "@/lib/chat";

/**
 * The live view's noVNC page and files (#597), fetched from the Screen by the Bot SDK with the
 * traffic token added server-side. No sign-in: the view token in the path is the authentication,
 * and a request without a valid one answers 403. Its socket is not here: see the README.
 */
const handle = (request: Request) => chat.plugin("bot").screenHandler(request);

export const GET = handle;
export const HEAD = handle;
