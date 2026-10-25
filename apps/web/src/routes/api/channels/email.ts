import { createFileRoute } from "@tanstack/react-router";

import { sdk } from "../../../services";

/**
 * The Bot SDK's inbound email route (spec #761). No sign-in: the SDK checks the sender, and answers
 * 202 to any mail it can read, so a sender learns nothing, and 400 to one it can't.
 */
const handle = ({ request }: { request: Request }) => sdk.channels.inbound("email", request);

export const Route = createFileRoute("/api/channels/email")({
  server: {
    handlers: {
      POST: handle,
    },
  },
});
