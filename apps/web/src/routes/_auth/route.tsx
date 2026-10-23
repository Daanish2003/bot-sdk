import { createFileRoute, redirect } from "@tanstack/react-router";

import { BotsShell } from "@/components/bots-shell";
import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/_auth")({
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
