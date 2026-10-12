import type { AppRouterClient } from "../../core/server/routers/index";
import { groupByDate } from "../../core/client/date-groups";
import { modelLabel } from "../../core/client/models";
import { relativeTime } from "../../core/client/relative-time";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  FolderIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ShareDialog } from "../share/share-dialog";
import { useDeleteConversation } from "../../core/client/react/delete-conversation";
import {
  useMoveConversation,
  usePinConversation,
  useRenameConversation,
} from "../../core/client/react/conversation-actions";
import { useChatAdapter, useOrpc } from "../../core/client/react/provider";
import { ProjectsSection } from "./projects-section";

export type ConversationSummary = Awaited<
  ReturnType<AppRouterClient["conversation"]["list"]>
>["items"][number];

/**
 * The Conversation panel: the pinned Conversations at the top, then the user's Conversations
 * outside Projects, newest Message first, grouped by date.
 */
export function ConversationPanel({ className }: { className?: string }) {
  const orpc = useOrpc();
  const conversations = useInfiniteQuery(
    orpc.conversation.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const pinned = useQuery(orpc.conversation.pinned.queryOptions());
  const rows = conversations.data?.pages.flatMap((page) => page.items) ?? [];
  const groups = groupByDate(rows, (row) => row.lastMessageAt);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = conversations;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Loads the next page once the end of the list scrolls into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const pinnedRows = pinned.data ?? [];

  return (
    <aside
      aria-label="Conversations"
      className={cn("flex w-72 shrink-0 flex-col border-r bg-sidebar/50", className)}
    >
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <span className="text-xs font-medium">Conversations</span>
        <span className="text-[10px] text-muted-foreground">{rows.length + pinnedRows.length}</span>
      </div>
      {conversations.isSuccess && rows.length === 0 && pinnedRows.length === 0 && (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">No Conversations yet</p>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {pinnedRows.length > 0 && (
          <section aria-label="Pinned">
            <h3 className="sticky top-0 z-10 bg-sidebar/95 px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
              Pinned
            </h3>
            <ul>
              {pinnedRows.map((row) => (
                <ConversationRow key={row.id} conversation={row} />
              ))}
            </ul>
          </section>
        )}
        <ProjectsSection />
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label}>
            <h3 className="sticky top-0 z-10 bg-sidebar/95 px-3 py-1.5 text-[10px] font-medium text-muted-foreground">
              {group.label}
            </h3>
            <ul>
              {group.rows.map((row) => (
                <ConversationRow key={row.id} conversation={row} />
              ))}
            </ul>
          </section>
        ))}
        <div ref={sentinelRef} />
        {isFetchingNextPage && (
          <p className="px-3 py-2 text-center text-[10px] text-muted-foreground">Loading…</p>
        )}
      </div>
    </aside>
  );
}

/** One Conversation in the panel, with its menu: rename, pin or unpin, move, share and delete. */
export function ConversationRow({ conversation }: { conversation: ConversationSummary }) {
  const { Link, orpc } = useChatAdapter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const remove = useDeleteConversation();
  const rename = useRenameConversation();
  const pin = usePinConversation();
  const move = useMoveConversation();
  const projects = useQuery({ ...orpc.project.list.queryOptions(), enabled: moveOpen });
  const pinned = conversation.pinnedAt !== null;
  // Moving to the Project the Conversation is already in does nothing, so it isn't offered.
  const targets = (projects.data?.items ?? []).filter((item) => item.id !== conversation.projectId);

  const pick = (action: () => void) => {
    setMenuOpen(false);
    setMoveOpen(false);
    action();
  };

  return (
    <li className="group relative border-b">
      <Link
        page={{ to: "conversation", id: conversation.id }}
        className="block border-l-2 border-l-transparent px-3 py-2 hover:bg-sidebar-accent"
        activeClassName="border-l-primary bg-sidebar-accent"
      >
        <div className="flex items-center gap-2">
          {pinned && <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-primary" />}
          <span className="flex-1 truncate text-xs font-medium">
            {conversation.title ?? <i className="text-muted-foreground">Untitled</i>}
          </span>
          <time
            dateTime={conversation.lastMessageAt.toISOString()}
            className="text-[10px] text-muted-foreground group-focus-within:invisible group-hover:invisible pointer-coarse:visible"
          >
            {relativeTime(conversation.lastMessageAt)}
          </time>
        </div>
        <p className="mt-0.5 line-clamp-1 min-h-4 text-[11px] text-muted-foreground">
          {conversation.preview}
        </p>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="truncate">{modelLabel(conversation.model)}</span>
          {conversation.shared && (
            <Share2Icon aria-label="Shared" className="size-3 shrink-0 text-primary" />
          )}
          {conversation.hasError && <span className="text-destructive">error</span>}
        </div>
      </Link>
      <Popover
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (!open) setMoveOpen(false);
        }}
      >
        <PopoverTrigger
          aria-label={`Actions for "${conversation.title ?? "Untitled"}"`}
          title="Conversation actions"
          disabled={remove.isPending || pin.isPending || move.isPending}
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-xs" }),
            "absolute top-1.5 right-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:top-auto pointer-coarse:bottom-1.5 pointer-coarse:opacity-100",
          )}
        >
          <MoreHorizontalIcon />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          {moveOpen ? (
            <div role="menu" aria-label="Move to Project" className="flex flex-col">
              <Button
                variant="ghost"
                size="sm"
                role="menuitem"
                className="justify-start"
                onClick={() => setMoveOpen(false)}
              >
                Back
              </Button>
              {conversation.projectId && (
                <Button
                  variant="ghost"
                  size="sm"
                  role="menuitem"
                  className="justify-start"
                  onClick={() => pick(() => move.moveTo(conversation, null))}
                >
                  Remove from Project
                </Button>
              )}
              {targets.map((target) => (
                <Button
                  key={target.id}
                  variant="ghost"
                  size="sm"
                  role="menuitem"
                  className="justify-start"
                  onClick={() => pick(() => move.moveTo(conversation, target.id))}
                >
                  <FolderIcon />
                  <span className="truncate">{target.name}</span>
                </Button>
              ))}
              {projects.isSuccess && targets.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {conversation.projectId ? "No other Projects" : "No Projects yet"}
                </p>
              )}
            </div>
          ) : (
            <div role="menu" className="flex flex-col">
              <Button
                variant="ghost"
                size="sm"
                role="menuitem"
                className="justify-start"
                onClick={() => pick(() => rename.promptRename(conversation))}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                role="menuitem"
                className="justify-start"
                onClick={() => pick(() => pin.toggle(conversation))}
              >
                {pinned ? <PinOffIcon /> : <PinIcon />}
                {pinned ? "Unpin" : "Pin"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                role="menuitem"
                className="justify-start"
                onClick={() => setMoveOpen(true)}
              >
                <FolderIcon />
                Move to Project
              </Button>
              <Button
                variant="ghost"
                size="sm"
                role="menuitem"
                className="justify-start"
                onClick={() => pick(() => setSharing(true))}
              >
                <Share2Icon />
                Share
              </Button>
              <Button
                variant="ghost"
                size="sm"
                role="menuitem"
                className="justify-start hover:text-destructive"
                onClick={() => pick(() => remove.confirmDelete(conversation))}
              >
                <Trash2Icon />
                Delete
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {sharing && (
        <ShareDialog conversationId={conversation.id} open={sharing} onOpenChange={setSharing} />
      )}
    </li>
  );
}
