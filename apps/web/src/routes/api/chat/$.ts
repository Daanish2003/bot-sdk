import { createFileRoute } from "@tanstack/react-router";

import { http } from "../../../services";

/** The Bot SDK's HTTP handler: every namespace's RPC calls and routes. */
const handle = ({ request }: { request: Request }) => http(request);

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
