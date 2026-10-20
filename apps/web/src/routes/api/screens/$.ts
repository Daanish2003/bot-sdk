import { createFileRoute } from "@tanstack/react-router";

import { sdk } from "../../../services";

/**
 * The live view's noVNC page and files (#597), fetched from the Screen by the Bot SDK with the
 * traffic token added server-side. No sign-in: the view token in the path is the authentication,
 * and a request without a valid one answers 403. Its socket is the Nitro route beside it.
 */
const handle = ({ request }: { request: Request }) => sdk.plugin("bot").screenHandler(request);

export const Route = createFileRoute("/api/screens/$")({
  server: {
    handlers: {
      HEAD: handle,
      GET: handle,
    },
  },
});
