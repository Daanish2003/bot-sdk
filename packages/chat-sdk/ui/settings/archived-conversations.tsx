import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { AppRouterClient } from "../../core/server/routers/index";
import { relativeTime } from "../../core/client/relative-time";
import { invalidateConversationList } from "../../core/client/react/conversation-list";
import { useArchiveConversation } from "../../core/client/react/conversation-actions";
import { useDeleteConversation } from "../../core/client/react/delete-conversation";
import { useChatAdapter, useOrpc } from "../../core/client/react/provider";

type ArchivedConversation = Awaited<
  ReturnType<AppRouterClient["conversation"]["archived"]>
>["items"][number];

/**
 * Settings: the user's archived Conversations, newest Message first, a page at a time as the list
 * scrolls. Each can be opened, unarchived or deleted. "Archive all" archives every unpinned
 * Conversation outside a Project, after a confirm.
 */
export function ArchivedConversationsSection() {
  const orpc = useOrpc();
  const archived = useInfiniteQuery(
    orpc.conversation.archived.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const rows = archived.data?.pages.flatMap((page) => page.items) ?? [];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = archived;
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
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Archived Conversations</h2>
        <ArchiveAllButton />
      </div>
      <p className="text-xs text-muted-foreground">
        Archived Conversations leave the sidebar but stay in search and open by their link. Sending
        them a Message brings them back.
      </p>
      {archived.isError && (
        <p role="alert" className="text-xs text-destructive">
          Couldn't load your archived Conversations: {archived.error.message}
        </p>
      )}
      {archived.isSuccess && rows.length === 0 && (
        <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
          You haven't archived any Conversations.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {rows.map((row) => (
            <ArchivedRow key={row.id} conversation={row} />
          ))}
        </ul>
      )}
      <div ref={sentinelRef} />
      {isFetchingNextPage && <p className="text-xs text-muted-foreground">Loading…</p>}
    </section>
  );
}

function ArchivedRow({ conversation }: { conversation: ArchivedConversation }) {
  const { Link } = useChatAdapter();
  const archive = useArchiveConversation();
  const remove = useDeleteConversation();
  const busy = archive.isPending || remove.isPending;

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {conversation.title ?? <i className="text-muted-foreground">Untitled</i>}
        </p>
        <p className="text-xs text-muted-foreground">
          Last message {relativeTime(conversation.lastMessageAt)}
        </p>
      </div>
      <Link
        page={{ to: "conversation", id: conversation.id }}
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
      >
        Open
      </Link>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => archive.unarchive(conversation.id)}
      >
        Unarchive
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => remove.confirmDelete(conversation)}
      >
        Delete
      </Button>
    </li>
  );
}

/** Archives every unpinned Conversation outside a Project, behind a confirm. */
function ArchiveAllButton() {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const [open, setOpen] = useState(false);
  const archiveAll = useMutation(
    orpc.conversation.archiveAll.mutationOptions({
      onSuccess: async ({ count }) => {
        setOpen(false);
        toast.success(count === 1 ? "Archived 1 Conversation" : `Archived ${count} Conversations`);
        // The sidebar's lists, the archived list and the Conversation open in the page.
        await Promise.all([
          invalidateConversationList(queryClient, orpc),
          queryClient.invalidateQueries({ queryKey: orpc.conversation.get.key() }),
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" />}>
        Archive all
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive all Conversations?</AlertDialogTitle>
          <AlertDialogDescription>
            This archives every Conversation outside your Projects that isn't pinned. Pinned
            Conversations and those in Projects stay where they are. You can unarchive any of them
            from this list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button disabled={archiveAll.isPending} onClick={() => archiveAll.mutate()}>
            {archiveAll.isPending ? "Archiving…" : "Archive all"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
