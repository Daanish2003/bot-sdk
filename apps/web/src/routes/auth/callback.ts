import { createFileRoute } from "@tanstack/react-router";

import { chatgptCallbackRedirect } from "../../chatgpt-callback";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => chatgptCallbackRedirect(request),
    },
  },
});
