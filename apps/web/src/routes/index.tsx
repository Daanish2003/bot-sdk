import { createFileRoute, redirect } from "@tanstack/react-router";

import { getUser } from "@/functions/get-user";

/** No page of its own: signed in, the Bots app; otherwise the login page. */
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    throw redirect({ to: (await getUser()) ? "/bots" : "/login" });
  },
});
