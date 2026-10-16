import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useChatAdapter, useI18n, useOrpc } from "../../../../core/client/react/provider";
import { serverErrorText } from "../../../../core/client/rpc-error";

type ListedMemory = {
  id: string;
  text: string;
  origin: "extracted" | "said";
  createdAt: Date | string;
  conversationId: string;
  conversationTitle: string | null;
  sourceMessageId: string;
};

type MemoryGroup = {
  projectId: string | null;
  projectName: string | null;
  items: ListedMemory[];
};

/**
 * Settings: the Memories the assistant has learned, General first and then by Project, with the
 * "Use and make Memories" switch and Delete all at the top. Each Memory links to the Message it came
 * from; edit and delete show on hover, and editing is inline (Enter saves, Esc cancels). Hidden when
 * the Host turns Memory off.
 */
export function MemorySection() {
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const status = useQuery(orpc.memory.status.queryOptions());
  const list = useQuery({
    ...orpc.memory.list.queryOptions(),
    enabled: status.data?.hostEnabled === true,
  });
  const refresh = useMemoryRefresh();
  const setEnabled = useMutation(
    orpc.memory.setEnabled.mutationOptions({
      onSuccess: refresh,
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const deleteAll = useMutation(
    orpc.memory.deleteAll.mutationOptions({
      onSuccess: async () => {
        toast.success(t("settings.memoryDeletedAll"));
        await refresh();
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  if (status.isPending || status.data?.hostEnabled !== true) return null;
  const { enabled, embeddingAvailable } = status.data;
  const groups: MemoryGroup[] = list.data?.groups ?? [];

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("settings.memory")}</h2>
        <p className="text-xs text-muted-foreground">{t("settings.memoryHelp")}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          role="switch"
          aria-checked={enabled}
          variant="outline"
          size="sm"
          disabled={setEnabled.isPending}
          onClick={() => setEnabled.mutate({ enabled: !enabled })}
        >
          <span
            aria-hidden
            className={
              enabled
                ? "size-2 rounded-full bg-green-500"
                : "size-2 rounded-full bg-muted-foreground/40"
            }
          />
          {t("settings.memoryUse")}
        </Button>

        {confirmingDeleteAll ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span>{t("settings.memoryDeleteAllConfirm")}</span>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteAll.isPending}
              onClick={async () => {
                await deleteAll.mutateAsync();
                setConfirmingDeleteAll(false);
              }}
            >
              {t("settings.deleteAll")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDeleteAll(false)}>
              {t("settings.cancel")}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={groups.length === 0}
            onClick={() => setConfirmingDeleteAll(true)}
          >
            {t("settings.memoryDeleteAll")}
          </Button>
        )}
      </div>

      {!enabled && (
        <p role="status" className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          {t("settings.memoryOffBanner")}
        </p>
      )}
      {!embeddingAvailable && (
        <p role="status" className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          {t("settings.memoryNoEmbeddingBanner")}
        </p>
      )}
      {list.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.memoryLoadFailed", { message: serverErrorText(i18n, list.error) })}
        </p>
      )}

      {!list.isPending && groups.length === 0 && (
        <p className="rounded-xl border px-4 py-6 text-center text-sm text-muted-foreground">
          {t("settings.memoryEmpty")}
        </p>
      )}

      {groups.map((group) => (
        <MemoryGroupList key={group.projectId ?? "general"} group={group} />
      ))}
    </section>
  );
}

/** Refetches the list and the status after a change to the Memories. */
function useMemoryRefresh() {
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.memory.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: orpc.memory.status.queryKey() }),
    ]);
  };
}

function MemoryGroupList({ group }: { group: MemoryGroup }) {
  const { t } = useI18n();
  const title =
    group.projectId === null
      ? t("settings.memoryGeneral")
      : t("settings.memoryProject", { name: group.projectName ?? "" });
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {title}
        <span className="tabular-nums">{group.items.length}</span>
      </h3>
      <ul className="divide-y overflow-hidden rounded-xl border">
        {group.items.map((item) => (
          <MemoryRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function MemoryRow({ item }: { item: ListedMemory }) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const { Link } = useChatAdapter();
  const orpc = useOrpc();
  const refresh = useMemoryRefresh();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const edit = useMutation(
    orpc.memory.edit.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await refresh();
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const remove = useMutation(
    orpc.memory.delete.mutationOptions({
      onSuccess: async () => {
        toast.success(t("settings.memoryDeleted"));
        await refresh();
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  const cancel = () => {
    setDraft(item.text);
    setEditing(false);
  };
  const save = () => {
    const text = draft.trim();
    if (text === "" || text === item.text) {
      cancel();
      return;
    }
    edit.mutate({ id: item.id, text });
  };

  const date = new Date(item.createdAt).toLocaleDateString(locale, { dateStyle: "medium" });
  const conversationTitle = item.conversationTitle ?? t("settings.memoryUntitled");

  return (
    <li className="group space-y-1 px-4 py-3">
      {editing ? (
        <Input
          autoFocus
          aria-label={t("settings.memoryEditLabel")}
          value={draft}
          disabled={edit.isPending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
        />
      ) : (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm">{item.text}</p>
          <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="xs"
              aria-label={t("settings.memoryEditLabel")}
              onClick={() => setEditing(true)}
            >
              {t("settings.memoryEdit")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-label={t("settings.memoryDeleteLabel")}
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: item.id })}
            >
              {t("settings.memoryDelete")}
            </Button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {item.origin === "said" && t("settings.memoryAsked")}
        {date} ·{" "}
        <Link
          page={{ to: "conversation", id: item.conversationId, message: item.sourceMessageId }}
          className="underline underline-offset-2"
        >
          {t("settings.memoryFrom", { title: conversationTitle })}
        </Link>
      </p>
    </li>
  );
}
