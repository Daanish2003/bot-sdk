import { createFileRoute, redirect } from "@tanstack/react-router";

import { BotsShell } from "@/components/bots-shell";
import { getUser } from "@/functions/get-user";

/** The Bots app: signed in, with the same session guard and shell as `_auth`. */
export const Route = createFileRoute("/bots")({
  component: BotsShell,
  beforeLoad: async () => {
    const session = await getUser();
    if (!session) {
      throw redirect({
        to: "/login",
      });
    }
    return { session };
  },
  loader: async ({ context }) => {
    if (!context.session) {
      throw redirect({
        to: "/login",
      });
    }
  },
});
