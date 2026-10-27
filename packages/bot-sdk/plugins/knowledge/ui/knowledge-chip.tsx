import { Button } from "@/components/ui/button";
import type { BotKnowledgeChange } from "@botsdk/client/knowledge/changes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import type { KnowledgeContract } from "../shared/contract";

const kib = 1024;
const mib = kib * kib;

/** A size as "512 B", "2 KB" or "31 MB": one decimal at most, none when it is whole. */
function sizeText(bytes: number): string {
  const whole = (value: number) => String(Math.round(value * 10) / 10);
  if (bytes >= mib) return `${whole(bytes / mib)} MB`;
  if (bytes >= kib) return `${whole(bytes / kib)} KB`;
  return `${bytes} B`;
}

/** The expanded details of one saved file: its size and readable text, and Delete. */
function KnowledgeFileDetails({ path, onDeleted }: { path: string; onDeleted: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc<{ knowledge: KnowledgeContract }>();
  const queryClient = useQueryClient();
  const file = useQuery(orpc.knowledge.read.queryOptions({ input: { path } }));
  const remove = useMutation(orpc.knowledge.remove.mutationOptions());
  return (
    <div className="w-[32rem] max-w-full rounded-lg border p-2 text-foreground">
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-medium">{path}</span>
        {file.data && <span className="text-muted-foreground">{sizeText(file.data.size)}</span>}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { path },
              {
                onSuccess: () => {
                  toast.success(t("bots.knowledgeDeleted"));
                  void queryClient.invalidateQueries({ queryKey: orpc.knowledge.key() });
                  onDeleted();
                },
                onError: (error) => toast.error(serverErrorText(i18n, error)),
              },
            )
          }
        >
          {t("bots.knowledgeDelete")}
        </Button>
      </div>
      {file.isError && (
        <p role="alert" className="text-xs text-destructive">
          {serverErrorText(i18n, file.error)}
        </p>
      )}
      {file.data && (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap text-xs">
          {file.data.content}
        </pre>
      )}
    </div>
  );
}

/**
 * The "📚 <Bot> saved to Knowledge: <path>" chips under a Bot Message whose Turn wrote a file under
 * `shared/knowledge/` (spec #737), one per file. A chip expands in place to the file's path, size
 * and readable text, with **Delete**. The Bot's name comes from `bots.get`, and is "a Bot" until
 * that loads. Shows nothing when the Turn saved no Knowledge.
 */
export function KnowledgeChip({
  botId,
  changes,
}: {
  botId: string;
  changes: BotKnowledgeChange[] | null;
}) {
  const { t } = useI18n();
  const orpc = useOrpc<{ knowledge: KnowledgeContract }>();
  // The Bot page already loads this, so it reads the cache.
  const botName = useQuery({
    ...orpc.bots.get.queryOptions({ input: { botId } }),
    select: (conversation) => conversation.bot.name,
    enabled: (changes?.length ?? 0) > 0,
  }).data;
  const [open, setOpen] = useState<string | null>(null);
  if (!changes || changes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 self-start text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-1">
        {changes.map((change) => (
          <button
            key={change.path}
            type="button"
            aria-expanded={open === change.path}
            className="rounded-full border px-2 py-0.5"
            onClick={() => setOpen(open === change.path ? null : change.path)}
          >
            {t("bots.knowledgeSaved", {
              name: botName ?? t("bots.knowledgeSavedByBot"),
              path: change.path,
            })}
          </button>
        ))}
      </div>
      {open && <KnowledgeFileDetails key={open} path={open} onDeleted={() => setOpen(null)} />}
    </div>
  );
}
