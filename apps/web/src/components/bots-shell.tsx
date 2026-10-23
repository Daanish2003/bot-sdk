import { BotsApp } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { Outlet, useRouteContext } from "@tanstack/react-router";

import AccountMenu from "@/components/account-menu";

/** The signed-in shell: the Bots sidebar with the account menu at its foot, then the page. */
export function BotsShell() {
  const { session } = useRouteContext({ strict: false });
  return (
    <BotsApp
      accountMenu={
        session && (
          <AccountMenu
            name={session.user.name}
            email={session.user.email}
            isAdmin={session.user.role === "admin"}
          />
        )
      }
    >
      <Outlet />
    </BotsApp>
  );
}
