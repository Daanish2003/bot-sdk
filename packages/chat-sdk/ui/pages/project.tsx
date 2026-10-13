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

import { useChatAdapter, useI18n, useOrpc } from "../../core/client/react/provider";
import { serverErrorText } from "../../core/client/rpc-error";
import { ConversationRow } from "../shell/conversation-panel";
import { EditProjectForm } from "./edit-project-form";

/**
 * A Project: its name, its Conversations (newest Message first), "New chat in this Project", and an
 * edit form for its name and default Model.
 */
export function ProjectPage({ projectId }: { projectId: string }) {
  const orpc = useOrpc();
  const { Link } = useChatAdapter();
  const { t } = useI18n();
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
    return <p className="p-6 text-sm text-muted-foreground">{t("pages.projectUnavailable")}</p>;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="truncate text-lg font-semibold">
          {project.data?.name ?? t("pages.project")}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          {project.data && (
            <Button
              variant="outline"
              size="sm"
              aria-expanded={editing}
              onClick={() => setEditing((open) => !open)}
            >
              {t("pages.edit")}
            </Button>
          )}
          <Link page={{ to: "new", projectId }} className={buttonVariants({ size: "sm" })}>
            {t("pages.newChatInProject")}
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
        <p className="text-sm text-muted-foreground">{t("pages.noProjectConversations")}</p>
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
          {conversations.isFetchingNextPage ? t("shell.loading") : t("pages.loadMore")}
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
  const i18n = useI18n();
  const { t } = i18n;
  const [open, setOpen] = useState(false);
  const count = useQuery(
    orpc.project.conversationCount.queryOptions({ input: { id: projectId }, enabled: open }),
  );
  const remove = useMutation(
    orpc.project.delete.mutationOptions({
      onSuccess: async ({ count: removed }) => {
        setOpen(false);
        toast.success(
          t("pages.projectDeleted", {
            conversations: t("pages.conversationCount", { count: removed }),
          }),
        );
        // The sidebar's Projects section, the Pinned section, the lists and the Shared links.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.project.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.conversation.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.share.key() }),
        ]);
        await navigate({ to: "new" });
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const total = count.data?.count;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
        {t("pages.deleteProject")}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("pages.deleteProjectTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {count.isError
              ? t("pages.countUnavailable")
              : total === undefined
                ? t("pages.countChecking")
                : t("pages.deleteProjectBody", {
                    conversations: t("pages.conversationCount", { count: total }),
                  })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("pages.cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={total === undefined || remove.isPending}
            onClick={() => remove.mutate({ id: projectId })}
          >
            {remove.isPending ? t("pages.deleting") : t("pages.deleteProject")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
