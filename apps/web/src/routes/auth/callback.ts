import { createFileRoute } from "@tanstack/react-router";

import { ENV } from "../../env.server";
import { chatgptCallbackRedirect } from "../../chatgpt-callback";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => chatgptCallbackRedirect(request, ENV.BETTER_AUTH_URL),
    },
  },
});
