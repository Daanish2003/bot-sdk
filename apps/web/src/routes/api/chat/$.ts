import { createFileRoute } from "@tanstack/react-router";

import { sdk } from "../../../services";

/** The Bot SDK's handler: every plugin's RPC calls and routes. */
const handle = ({ request }: { request: Request }) => sdk.handler(request);

export const Route = createFileRoute("/api/chat/$")({
  server: {
    handlers: {
      HEAD: handle,
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
});
