import { createFileRoute } from "@tanstack/react-router";

import { captureEnabled, mailbox } from "../../email";

// Test-only: the messages captured for an address, oldest first. Exists only while the capture
// transport is on; any other transport answers 404, as if the route were not there.
export const Route = createFileRoute("/api/test-mailbox")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!captureEnabled) return new Response("Not Found", { status: 404 });
        const email = new URL(request.url).searchParams.get("email") ?? "";
        const messages = (await mailbox.read(email)).map(({ template, subject, text }) => ({
          template,
          subject,
          text,
        }));
        return Response.json(messages);
      },
    },
  },
});
