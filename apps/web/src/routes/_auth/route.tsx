import { AppShell } from "@ai-chat/chat-sdk/ui";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { InstallPrompt } from "@/components/install-prompt";
import UserMenu from "@/components/user-menu";
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

function AuthLayout() {
  return (
    <AppShell userMenu={<UserMenu />} installPrompt={<InstallPrompt />}>
      <Outlet />
    </AppShell>
  );
}
