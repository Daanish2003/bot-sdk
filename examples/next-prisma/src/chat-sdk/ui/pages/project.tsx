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
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useChatAdapter, useOrpc } from "../../core/client/react/provider";
import { ConversationRow } from "../shell/conversation-panel";
import { EditProjectForm } from "./edit-project-form";

/**
 * A Project: its name, its Conversations (newest Message first), "New chat in this Project", and an
 * edit form for its name and default Model.
 */
export function ProjectPage({ projectId }: { projectId: string }) {
  const orpc = useOrpc();
  const { Link } = useChatAdapter();
  const project = useQuery(orpc.project.get.queryOptions({ input: { id: projectId } }));
  const [editing, setEditing] = useState(false);
  const conversations = useInfiniteQuery(
    orpc.conversation.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ cursor, projectId }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const rows = conversations.data?.pages.flatMap((page) => page.items) ?? [];

  if (project.error || conversations.error) {
    return <p className="p-6 text-sm text-muted-foreground">This Project can&apos;t be opened.</p>;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="truncate text-lg font-semibold">{project.data?.name ?? "Project"}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {project.data && (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={editing}
              onClick={() => setEditing((open) => !open)}
            >
              Edit
            </Button>
          )}
          <Link page={{ to: "new", projectId }} className={buttonVariants({ size: "sm" })}>
            New chat in this Project
          </Link>
          <DeleteProjectButton projectId={projectId} />
        </div>
      </header>
      {editing && project.data && (
        <EditProjectForm
          projectId={projectId}
          name={project.data.name}
          defaultModel={project.data.defaultModel}
          instructions={project.data.instructions}
          onDone={() => setEditing(false)}
        />
      )}
      {conversations.isSuccess && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No Conversations in this Project yet</p>
      )}
      {rows.length > 0 && (
        <ul className="overflow-hidden rounded-md border">
          {rows.map((row) => (
            <ConversationRow key={row.id} conversation={row} />
          ))}
        </ul>
      )}
      {conversations.hasNextPage && (
        <Button
          variant="outline"
          disabled={conversations.isFetchingNextPage}
          onClick={() => void conversations.fetchNextPage()}
        >
          {conversations.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}

/**
 * Deletes the Project with its Conversations, after a confirmation that says how many go. The
 * count is read when the dialog opens. On success the user leaves the Project's page.
 */
function DeleteProjectButton({ projectId }: { projectId: string }) {
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  const { navigate } = useChatAdapter();
  const [open, setOpen] = useState(false);
  const count = useQuery(
    orpc.project.conversationCount.queryOptions({ input: { id: projectId }, enabled: open }),
  );
  const remove = useMutation(
    orpc.project.delete.mutationOptions({
      onSuccess: async ({ count: removed }) => {
        setOpen(false);
        toast.success(`Project deleted with ${conversationsLabel(removed)}`);
        // The sidebar's Projects section, the Pinned section, the lists and the Shared links.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.project.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.conversation.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.share.key() }),
        ]);
        await navigate({ to: "new" });
      },
      onError: (error) => toast.error(error.message),
    }),
  );
  const total = count.data?.count;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
        Delete Project
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this Project?</AlertDialogTitle>
          <AlertDialogDescription>
            {count.isError
              ? "Couldn't count this Project's Conversations, so it can't be deleted right now."
              : total === undefined
                ? "Checking how many Conversations it holds…"
                : `This deletes the Project and its ${conversationsLabel(total)}, with their Messages and Shared links. This can't be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={total === undefined || remove.isPending}
            onClick={() => remove.mutate({ id: projectId })}
          >
            {remove.isPending ? "Deleting…" : "Delete Project"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "1 Conversation", "3 Conversations", "no Conversations". */
function conversationsLabel(count: number) {
  if (count === 0) return "no Conversations";
  return `${count} ${count === 1 ? "Conversation" : "Conversations"}`;
}
