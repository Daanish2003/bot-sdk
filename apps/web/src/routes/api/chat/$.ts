import { createFileRoute } from "@tanstack/react-router";

import { sdk } from "../../../services";

/** The Bot SDK's handler: RPC calls, the Run POST and join GET, and the public Shared link read. */
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
