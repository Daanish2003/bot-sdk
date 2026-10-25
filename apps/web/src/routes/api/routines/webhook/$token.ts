import { createFileRoute } from "@tanstack/react-router";

import { sdk } from "../../../../services";

/**
 * The Bot SDK's inbound webhook for webhook Routines (ADR 0021). No sign-in: the token in the URL is
 * the authentication, and the handler answers 202, 404 or 413.
 */
const handle = ({ request }: { request: Request }) => sdk.bots.webhookHandler(request);

export const Route = createFileRoute("/api/routines/webhook/$token")({
  server: {
    handlers: {
      POST: handle,
    },
  },
});
