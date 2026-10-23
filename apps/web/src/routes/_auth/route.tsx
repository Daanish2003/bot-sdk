import { AppShell } from "@ai-chat/bot-sdk/plugins/assistant/ui";
import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";

import AccountMenu from "@/components/account-menu";
import { BotsShell } from "@/components/bots-shell";
import { InstallPrompt } from "@/components/install-prompt";
import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
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

/** The assistant routes (/c, /p) stay reachable by URL in their own shell until spec 3; the rest use the Bots shell. */
function AuthLayout() {
  const { session } = Route.useRouteContext();
  const onAssistantRoute = useLocation({ select: (l) => /^\/[cp](\/|$)/.test(l.pathname) });
  if (!onAssistantRoute) return <BotsShell />;
  return (
    <AppShell
      userMenu={
        <AccountMenu
          name={session.user.name}
          email={session.user.email}
          isAdmin={session.user.role === "admin"}
          compact
        />
      }
      installPrompt={<InstallPrompt />}
    >
      <Outlet />
    </AppShell>
  );
}
