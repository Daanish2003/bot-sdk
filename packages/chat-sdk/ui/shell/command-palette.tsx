import { minSearchLength } from "../../core/shared/search/text";
import { relativeTime } from "../../core/client/relative-time";
import {
  localDayRange,
  recentConversations,
  type SearchHit,
  splitSnippet,
} from "../../core/client/search";
import { providers } from "../../core/shared/credentials/services";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  KeyRoundIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  Share2Icon,
  TextSearchIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { invalidateConversationList } from "../../core/client/react/conversation-list";
import { useDeleteConversation } from "../../core/client/react/delete-conversation";
import { useChatAdapter, useChatLocation, useOrpc } from "../../core/client/react/provider";
import { ShareDialog } from "../share/share-dialog";

/** How long typing must pause before Messages are searched. */
const searchDebounceMs = 250;

type Item = {
  key: string;
  group: "Recent" | "Conversations" | "In Messages" | "Commands";
  icon: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  hint?: string;
  danger?: boolean;
  /** Runs the item; the palette closes afterwards unless it returns `"stay"`. */
  run: () => "stay" | void;
};

/**
 * The ⌘K / Ctrl+K palette: Recent Conversations (filtered by title), hits In Messages (every
 * Branch, 2+ characters, debounced) and Commands. ↑/↓ move, Enter runs, Esc closes.
 * Also owns the Share dialog its "Share…" command opens.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { conversationId } = useChatLocation();
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="top-[15vh] flex max-h-[70vh] translate-y-0 flex-col gap-0 p-0 sm:max-w-xl"
        >
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          {open && (
            <PaletteBody
              conversationId={conversationId}
              onClose={() => onOpenChange(false)}
              onShare={() => setShareOpen(true)}
            />
          )}
        </DialogContent>
      </Dialog>
      {conversationId && (
        <ShareDialog
          key={conversationId}
          conversationId={conversationId}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </>
  );
}

function PaletteBody({
  conversationId,
  onClose,
  onShare,
}: {
  conversationId: string | undefined;
  onClose: () => void;
  onShare: () => void;
}) {
  const { orpc, navigate } = useChatAdapter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const conversations = useInfiniteQuery(
    orpc.conversation.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const loaded = conversations.data?.pages.flatMap((page) => page.items) ?? [];
  const current = loaded.find((c) => c.id === conversationId);
  const remove = useDeleteConversation();
  const searched = useDebounced(q.trim(), searchDebounceMs);
  const [filters, setFilters] = useState<SearchFilterValue>({});
  const models = useQuery(orpc.models.list.queryOptions());
  const projects = useQuery(orpc.project.list.queryOptions());
  const search = useInfiniteQuery(
    orpc.search.query.infiniteOptions({
      input: (cursor: string | undefined) => ({
        q: searched,
        cursor,
        model: filters.model,
        provider: filters.provider,
        projectId: filters.projectId,
        ...localDayRange(filters.fromDay, filters.toDay),
      }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      enabled: searched.length >= minSearchLength,
    }),
  );
  const hits =
    searched.length >= minSearchLength
      ? (search.data?.pages.flatMap((page) => page.hits) ?? [])
      : [];

  const firstPage = conversations.data?.pages[0]?.items ?? [];
  const recent: Item[] = recentConversations(firstPage, q).map((c) => ({
    key: `conversation:${c.id}`,
    group: q.trim() ? "Conversations" : "Recent",
    icon: <MessageSquareIcon />,
    label: c.title ?? <i>Untitled</i>,
    hint: relativeTime(c.lastMessageAt),
    run: () => void navigate({ to: "conversation", id: c.id }),
  }));
  const openHit = (hit: SearchHit) =>
    navigate({ to: "conversation", id: hit.conversationId, message: hit.messageId });

  const inMessages: Item[] = hits.map((hit) => ({
    key: `message:${hit.messageId}`,
    group: "In Messages",
    icon: <TextSearchIcon />,
    label: hit.conversationTitle ?? <i>Untitled</i>,
    detail: <Snippet snippet={hit.snippet} />,
    hint: relativeTime(hit.createdAt),
    run: () => void openHit(hit),
  }));
  if (search.hasNextPage) {
    inMessages.push({
      key: "message:more",
      group: "In Messages",
      icon: <TextSearchIcon />,
      label: search.isFetchingNextPage ? "Loading…" : "More results",
      run: () => {
        void search.fetchNextPage();
        return "stay";
      },
    });
  }

  const commands: Item[] = [
    {
      key: "new",
      group: "Commands" as const,
      icon: <PlusIcon />,
      label: "New Conversation",
      run: () => void navigate({ to: "new" }),
    },
    ...(current
      ? [
          {
            key: "rename",
            group: "Commands" as const,
            icon: <PencilIcon />,
            label: "Rename this Conversation",
            run: () => {
              setRenaming(true);
              return "stay" as const;
            },
          },
          {
            key: "share",
            group: "Commands" as const,
            icon: <Share2Icon />,
            label: current.shared ? "Shared link…" : "Share…",
            run: onShare,
          },
          {
            key: "delete",
            group: "Commands" as const,
            icon: <Trash2Icon />,
            label: "Delete this Conversation",
            danger: true,
            run: () => remove.confirmDelete(current),
          },
        ]
      : []),
    {
      key: "keys",
      group: "Commands" as const,
      icon: <KeyRoundIcon />,
      label: "Keys & settings",
      run: () => void navigate({ to: "keys" }),
    },
  ].filter((command) => command.label.toLowerCase().includes(q.trim().toLowerCase()));

  const items = [...recent, ...inMessages, ...commands];
  const activeIndex = Math.min(active, items.length - 1);
  const activeKey = items[activeIndex]?.key;

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const runItem = (item: Item | undefined) => {
    if (item && item.run() !== "stay") onClose();
  };

  if (renaming && current) {
    return <RenameInput conversation={current} onDone={onClose} />;
  }

  const searching = searched.length >= minSearchLength && search.isPending;
  return (
    <>
      <input
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls="palette-list"
        aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
        aria-label="Search Conversations, Messages and commands"
        value={q}
        onChange={(event) => {
          setQ(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive(Math.min(activeIndex + 1, items.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(Math.max(activeIndex - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            runItem(items[activeIndex]);
          }
        }}
        placeholder="Jump to a Conversation, search Messages, or run a command…"
        className="h-12 w-full shrink-0 border-b bg-transparent px-4 text-sm outline-none"
      />
      <SearchFilterRow
        value={filters}
        onChange={setFilters}
        models={models.data?.models ?? []}
        projects={projects.data?.items ?? []}
      />
      <div
        ref={listRef}
        id="palette-list"
        role="listbox"
        aria-label="Results"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {groupsOf(items).map(([group, groupItems]) => (
          <div key={group} role="group" aria-label={group} className="p-1">
            <div className="px-3 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {group}
            </div>
            {groupItems.map((item) => (
              <div
                key={item.key}
                id={optionId(item.key)}
                role="option"
                aria-selected={item.key === activeKey}
                onMouseMove={() => setActive(items.indexOf(item))}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runItem(item)}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-xs [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                  item.key === activeKey && "bg-muted",
                  item.danger && "text-destructive",
                )}
              >
                {item.icon}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{item.label}</span>
                  {item.detail}
                </span>
                {item.hint && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">{item.hint}</span>
                )}
              </div>
            ))}
          </div>
        ))}
        {searching && <p className="px-4 py-2 text-xs text-muted-foreground">Searching…</p>}
        {search.isError && !searching && (
          <p role="alert" className="px-4 py-2 text-xs text-destructive">
            {search.error.message}
          </p>
        )}
        {items.length === 0 && !searching && !search.isError && (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">No matches</p>
        )}
      </div>
      <div className="flex shrink-0 gap-3 border-t px-4 py-2 text-[10px] text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>esc close</span>
      </div>
    </>
  );
}

/** The Message search's filters: a Model, a Provider, a Project, and a day range (`YYYY-MM-DD`, local). */
type SearchFilterValue = {
  model?: string;
  provider?: string;
  projectId?: string;
  fromDay?: string;
  toDay?: string;
};

/** The palette's filter controls; changing one re-runs the search from its first page. */
function SearchFilterRow({
  value,
  onChange,
  models,
  projects,
}: {
  value: SearchFilterValue;
  onChange: (value: SearchFilterValue) => void;
  models: { id: string; label: string; provider: string }[];
  projects: { id: string; name: string }[];
}) {
  const modelItems = [
    { value: null, label: "Any Model" },
    ...models.map((model) => ({ value: model.id, label: model.label })),
  ];
  // The Providers the user's Models come from (`models.list`), labelled as the Provider list names them.
  const providerItems = [
    { value: null, label: "Any Provider" },
    ...providers
      .filter((provider) => models.some((model) => model.provider === provider.id))
      .map((provider) => ({ value: provider.id, label: provider.label })),
  ];
  const projectItems = [
    { value: null, label: "Any Project" },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];
  return (
    <div
      role="group"
      aria-label="Search filters"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs"
    >
      <Select
        items={modelItems}
        value={value.model ?? null}
        onValueChange={(model) => onChange({ ...value, model: model ?? undefined })}
      >
        <SelectTrigger aria-label="Model" size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {modelItems.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        items={providerItems}
        value={value.provider ?? null}
        onValueChange={(provider) => onChange({ ...value, provider: provider ?? undefined })}
      >
        <SelectTrigger aria-label="Provider" size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {providerItems.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        items={projectItems}
        value={value.projectId ?? null}
        onValueChange={(projectId) => onChange({ ...value, projectId: projectId ?? undefined })}
      >
        <SelectTrigger aria-label="Project" size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {projectItems.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="date"
        aria-label="From"
        value={value.fromDay ?? ""}
        max={value.toDay}
        onChange={(event) => onChange({ ...value, fromDay: event.target.value || undefined })}
        className="h-7 w-auto text-xs"
      />
      <Input
        type="date"
        aria-label="To"
        value={value.toDay ?? ""}
        min={value.fromDay}
        onChange={(event) => onChange({ ...value, toDay: event.target.value || undefined })}
        className="h-7 w-auto text-xs"
      />
    </div>
  );
}

/** The plain-text snippet with its match in `<mark>`; never rendered as markdown or HTML. */
function Snippet({ snippet }: { snippet: SearchHit["snippet"] }) {
  const { before, match, after } = splitSnippet(snippet);
  return (
    <span className="line-clamp-2 text-muted-foreground">
      {before}
      <mark className="bg-primary/30 text-foreground">{match}</mark>
      {after}
    </span>
  );
}

/** Renames the open Conversation from the palette; Enter saves, Esc cancels. */
function RenameInput({
  conversation,
  onDone,
}: {
  conversation: { id: string; title: string | null };
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const rename = useMutation(
    orpc.conversation.rename.mutationOptions({
      onSuccess: (_, { id, title }) => {
        queryClient.setQueryData(
          orpc.conversation.get.queryKey({ input: { id } }),
          (old) => old && { ...old, title },
        );
        void invalidateConversationList(queryClient, orpc);
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  return (
    <input
      autoFocus
      aria-label="New title"
      placeholder="New title"
      maxLength={200}
      defaultValue={conversation.title ?? ""}
      className="h-12 w-full bg-transparent px-4 text-sm outline-none"
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const title = event.currentTarget.value.trim();
        if (title && title !== conversation.title) rename.mutate({ id: conversation.id, title });
        onDone();
      }}
    />
  );
}

function optionId(key: string) {
  return `palette-option-${key.replace(/[^\w-]/g, "-")}`;
}

/** Items grouped in order of first appearance. */
function groupsOf(items: Item[]) {
  const groups = new Map<Item["group"], Item[]>();
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  return [...groups];
}

function useDebounced<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
