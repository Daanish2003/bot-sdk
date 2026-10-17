import { BotsApp } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { getUser } from "@/functions/get-user";

/** The Bots app: signed in, with the same session guard as `_auth`, but without the assistant's shell. */
export const Route = createFileRoute("/bots")({
  component: BotsLayout,
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

function BotsLayout() {
  return (
    <BotsApp>
      <Outlet />
    </BotsApp>
  );
}
