import { missingCredentialsMessage } from "../../core/client/models";
import { awaitingTitle, titleWaitMs } from "../../core/client/title";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DownloadIcon,
  MenuIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PencilIcon,
  PrinterIcon,
  SearchIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { useExportConversation } from "../../core/client/react/conversation-actions";
import { invalidateConversationList } from "../../core/client/react/conversation-list";
import { useByok } from "../../core/client/react/byok";
import { useNewConversationModel } from "../../core/client/react/new-conversation-model";
import { useChatLocation, useI18n, useOrpc } from "../../core/client/react/provider";
import { serverErrorText } from "../../core/client/rpc-error";
import { ConversationHeaderActions } from "./conversation-header-actions";
import { ModelPicker } from "./model-picker";
import {
  ConversationReasoningEffort,
  NewConversationReasoningEffort,
} from "./reasoning-effort-select";

/** The bar above the page: the Conversation title (renamed inline) or the page's name. */
export function TopBar({
  panelOpen,
  drawerOpen,
  onOpenPanel,
  onOpenDrawer,
  onOpenSearch,
  userMenu,
}: {
  panelOpen: boolean;
  /** The small-screen drawer (rail and Conversation panel) is open. */
  drawerOpen: boolean;
  onOpenPanel: () => void;
  onOpenDrawer: () => void;
  /** Opens the ⌘K palette. */
  onOpenSearch: () => void;
  /** The host app's account menu, at the right end. */
  userMenu?: ReactNode;
}) {
  const { conversationId: id, newConversation, pageTitle } = useChatLocation();
  const modKey = useModKey();
  const { t } = useI18n();

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2 pt-[env(safe-area-inset-top)] max-md:h-auto max-md:min-h-11 sm:gap-2 print:hidden">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("shell.menu")}
        aria-controls="app-drawer"
        aria-expanded={drawerOpen}
        onClick={onOpenDrawer}
        className="md:hidden"
      >
        <MenuIcon />
      </Button>
      {!panelOpen && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("shell.showConversations")}
          onClick={onOpenPanel}
          className="max-md:hidden"
        >
          <PanelLeftIcon />
        </Button>
      )}
      {id ? (
        <ConversationTitle key={`title:${id}`} id={id} />
      ) : (
        <span className="truncate px-2 text-sm text-muted-foreground">
          {newConversation ? t("shell.newConversation") : pageTitle}
        </span>
      )}
      {(id || newConversation) && <span className="text-muted-foreground max-sm:hidden">/</span>}
      {id ? (
        <ConversationModelPicker key={`model:${id}`} id={id} />
      ) : (
        newConversation && <NewConversationModelPicker />
      )}
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-label={t("shell.search")}
        title={modKey ? t("shell.searchShortcut", { modKey }) : t("shell.search")}
        onClick={onOpenSearch}
      >
        <SearchIcon /> <span className="max-sm:hidden">{t("shell.search")}</span>
        {modKey && (
          <kbd className="rounded-sm border px-1 text-[10px] text-muted-foreground max-sm:hidden">
            {modKey}K
          </kbd>
        )}
      </Button>
      {id && <ConversationMenu key={`menu:${id}`} id={id} />}
      {id && <ConversationHeaderActions key={`actions:${id}`} id={id} />}
      {userMenu}
    </header>
  );
}

/** The open Conversation's menu: Export as Markdown and Print / Save as PDF (⌘K has both too). */
function ConversationMenu({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const exporter = useExportConversation();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Conversation menu"
        title="Conversation menu"
        disabled={exporter.isPending}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
      >
        <MoreHorizontalIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        <ConversationMenuItems
          disabled={exporter.isPending}
          onExport={() => {
            setOpen(false);
            exporter.exportMarkdown(id);
          }}
          onPrint={() => {
            setOpen(false);
            window.print();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The items of the Conversation menu. Both act on the open Conversation. */
export function ConversationMenuItems({
  disabled = false,
  onExport,
  onPrint,
}: {
  /** Export is busy. */
  disabled?: boolean;
  onExport: () => void;
  onPrint: () => void;
}) {
  return (
    <div role="menu" className="flex flex-col">
      <Button
        variant="ghost"
        size="sm"
        role="menuitem"
        className="justify-start"
        disabled={disabled}
        onClick={onExport}
      >
        <DownloadIcon />
        Export as Markdown
      </Button>
      <Button variant="ghost" size="sm" role="menuitem" className="justify-start" onClick={onPrint}>
        <PrinterIcon />
        Print / Save as PDF
      </Button>
    </div>
  );
}

const subscribeToNothing = () => () => {};

/**
 * The palette shortcut's modifier as this device labels it: "⌘" on Apple devices, "Ctrl+"
 * elsewhere. `undefined` on the server, which can't tell.
 */
function useModKey() {
  return useSyncExternalStore(
    subscribeToNothing,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"),
    () => undefined,
  );
}

/** Switches the open Conversation's Model; the next Message and regenerate use it. */
function ConversationModelPicker({ id }: { id: string }) {
  const i18n = useI18n();
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const conversation = useQuery(orpc.conversation.get.queryOptions({ input: { id } }));
  const models = useQuery(orpc.models.list.queryOptions());
  const byok = useByok();
  const getKey = orpc.conversation.get.queryKey({ input: { id } });
  const setModel = useMutation(
    orpc.conversation.setModel.mutationOptions({
      onMutate: ({ model }) => {
        const previous = conversation.data?.model;
        queryClient.setQueryData(getKey, (old) => old && { ...old, model });
        return { previous };
      },
      onSuccess: () => void invalidateConversationList(queryClient, orpc),
      onError: (error, _, context) => {
        const previous = context?.previous;
        if (previous) queryClient.setQueryData(getKey, (old) => old && { ...old, model: previous });
        toast.error(serverErrorText(i18n, error));
      },
      // A refetch already in flight (polling, a run ending) may have overwritten the optimistic
      // Model. Not cancelled: the chat view awaits those fetches.
      onSettled: () => queryClient.invalidateQueries({ queryKey: getKey }),
    }),
  );
  const value = conversation.data?.model;

  if (!value || !models.data) return null;
  return (
    <>
      <ModelPicker
        value={value}
        models={models.data.models}
        invalid={missingCredentialsMessage(i18n, value, models.data.models, byok) !== null}
        onSelect={(model) => setModel.mutate({ id, model })}
      />
      <ConversationReasoningEffort id={id} />
    </>
  );
}

/** Picks the Model a new Conversation will be created with. */
function NewConversationModelPicker() {
  const i18n = useI18n();
  const orpc = useOrpc();
  const models = useQuery(orpc.models.list.queryOptions());
  const byok = useByok();
  const { model, setModel } = useNewConversationModel();

  if (!models.data) return null;
  return (
    <>
      <ModelPicker
        value={model}
        models={models.data.models}
        invalid={
          model !== undefined &&
          missingCredentialsMessage(i18n, model, models.data.models, byok) !== null
        }
        onSelect={(next) => void setModel(next)}
      />
      <NewConversationReasoningEffort />
    </>
  );
}

function ConversationTitle({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  // The automatic title is written just after a reply completes: check for it for a while.
  const awaitingSince = useRef<number | undefined>(undefined);
  const conversation = useQuery({
    ...orpc.conversation.get.queryOptions({ input: { id } }),
    refetchInterval: (query) => {
      if (!awaitingTitle(query.state.data)) {
        awaitingSince.current = undefined;
        return false;
      }
      awaitingSince.current ??= Date.now();
      return Date.now() - awaitingSince.current < titleWaitMs ? 1_000 : false;
    },
  });
  // A title arriving for an untitled Conversation also changes its Conversation panel row.
  const loadedTitle = conversation.data?.title;
  const previousTitle = useRef(loadedTitle);
  useEffect(() => {
    if (previousTitle.current === null && loadedTitle)
      void invalidateConversationList(queryClient, orpc);
    previousTitle.current = loadedTitle;
  }, [loadedTitle, queryClient]);
  const [renaming, setRenaming] = useState(false);
  const rename = useMutation(
    orpc.conversation.rename.mutationOptions({
      onSuccess: (_, { title }) => {
        queryClient.setQueryData(
          orpc.conversation.get.queryKey({ input: { id } }),
          (old) => old && { ...old, title },
        );
        void invalidateConversationList(queryClient, orpc);
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const title = rename.isPending ? rename.variables.title : conversation.data?.title;

  const save = (value: string) => {
    setRenaming(false);
    const next = value.trim();
    if (next && next !== title) rename.mutate({ id, title: next });
  };

  if (renaming) {
    return (
      <input
        autoFocus
        aria-label={t("shell.conversationTitle")}
        defaultValue={title ?? ""}
        maxLength={200}
        className="h-7 w-72 min-w-0 rounded-md border bg-background px-2 text-sm outline-none"
        onBlur={(event) => save(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.value = title ?? "";
          if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
        }}
      />
    );
  }

  return (
    <button
      type="button"
      title={t("shell.rename")}
      disabled={!conversation.isSuccess}
      className="group flex min-w-10 items-center gap-1.5 px-2 text-sm font-medium"
      onClick={() => setRenaming(true)}
    >
      <span className="truncate">{title ?? t("shell.untitled")}</span>
      <PencilIcon className="size-3 shrink-0 opacity-0 group-hover:opacity-60 pointer-coarse:opacity-60" />
    </button>
  );
}
