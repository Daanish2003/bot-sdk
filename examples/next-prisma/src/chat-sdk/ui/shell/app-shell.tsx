import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquareIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useChatAdapter, useI18n } from "../../core/client/react/provider";
import { CommandPalette } from "./command-palette";
import { ConversationPanel } from "./conversation-panel";
import { QuotaSlotProvider } from "./quota-slot";
import { TopBar } from "./top-bar";

/** Where this browser remembers whether the Conversation panel is collapsed. */
const panelStorageKey = "ai-chat:conversation-panel";

/**
 * The signed-in layout: icon rail, collapsible Conversation panel, top bar, then the page.
 * On small screens the rail and panel are a drawer over the page instead.
 * `userMenu` is the host app's account menu, shown at the top bar's right end.
 * `quotaExceeded` is the host app's content for a user who has used up their Quota (ADR 0007),
 * shown in the composer's banner.
 * `installPrompt` is the host app's install UI (a PWA's "Install" row), shown at the drawer's bottom.
 */
export function AppShell({
  children,
  userMenu,
  quotaExceeded,
  installPrompt,
}: {
  children: ReactNode;
  userMenu?: ReactNode;
  quotaExceeded?: ReactNode;
  installPrompt?: ReactNode;
}) {
  const { orpc, Link } = useChatAdapter();
  const { t } = useI18n();
  const [panelOpen, setPanelOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const models = useQuery(orpc.models.list.queryOptions());
  const noCredentials = models.data?.models.length === 0;

  // Read after hydration, so the server's render (panel open) matches the first client one.
  useEffect(() => {
    if (readStorage(panelStorageKey) === "closed") setPanelOpen(false);
  }, []);
  const showPanel = (open: boolean) => {
    setPanelOpen(open);
    writeStorage(panelStorageKey, open ? "open" : "closed");
  };
  const openSearch = () => {
    setDrawerOpen(false);
    setPaletteOpen(true);
  };

  return (
    <QuotaSlotProvider slot={quotaExceeded}>
      <div className="flex min-h-0 flex-1">
        {drawerOpen && (
          <div
            aria-hidden
            className="fixed inset-0 z-30 bg-black/60 md:hidden"
            onClick={() => setDrawerOpen(false)}
          />
        )}
        <div
          id="app-drawer"
          className={cn(
            "fixed inset-y-0 left-0 z-40 flex flex-col bg-background transition-[translate,visibility] max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:pl-[env(safe-area-inset-left)] md:static md:z-auto md:transition-none",
            !drawerOpen && "max-md:invisible max-md:-translate-x-full",
          )}
          // Following a link (a Conversation, New Conversation, Keys) closes the drawer.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) setDrawerOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDrawerOpen(false);
          }}
        >
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label={t("shell.app")}
              className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2"
            >
              <Link
                page={{ to: "new" }}
                aria-label="ai-chat"
                className="mb-2 flex size-8 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
              >
                ai
              </Link>
              {noCredentials ? (
                <Button
                  variant="ghost"
                  size="icon"
                  title={t("shell.addCredentialsToStart")}
                  aria-label={t("shell.newConversation")}
                  disabled
                >
                  <PlusIcon />
                </Button>
              ) : (
                <Link
                  page={{ to: "new" }}
                  title={t("shell.newConversation")}
                  aria-label={t("shell.newConversation")}
                  className={buttonVariants({ variant: "ghost", size: "icon" })}
                >
                  <PlusIcon />
                </Link>
              )}
              <Button
                variant="ghost"
                size="icon"
                title={t("shell.searchTitle")}
                aria-label={t("shell.search")}
                aria-haspopup="dialog"
                onClick={openSearch}
              >
                <SearchIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title={t("shell.conversations")}
                aria-label={t("shell.conversations")}
                aria-pressed={panelOpen}
                onClick={() => showPanel(!panelOpen)}
                className={cn("max-md:hidden", panelOpen && "bg-sidebar-accent text-primary")}
              >
                <MessagesSquareIcon />
              </Button>
              <div className="flex-1" />
              <Link
                page={{ to: "keys" }}
                title={t("shell.keysAndSettings")}
                aria-label={t("shell.keysAndSettings")}
                className={buttonVariants({ variant: "ghost", size: "icon" })}
                activeClassName="bg-sidebar-accent text-primary"
              >
                <SettingsIcon />
              </Link>
            </nav>
            <ConversationPanel className={cn(!panelOpen && "md:hidden")} />
          </div>
          {installPrompt}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            panelOpen={panelOpen}
            drawerOpen={drawerOpen}
            onOpenPanel={() => showPanel(true)}
            onOpenDrawer={() => setDrawerOpen(true)}
            onOpenSearch={openSearch}
            userMenu={userMenu}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </QuotaSlotProvider>
  );
}

/** `localStorage` can be missing or throw (private windows, blocked storage). */
function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; the panel still toggles.
  }
}
