import { relativeTime } from "../../../../core/client/relative-time";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchServerSentEvents } from "@tanstack/ai-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, Link2Icon, Share2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { invalidateConversationList } from "../../../../core/client/react/conversation-list";
import { useChatAdapter, useI18n } from "../../../../core/client/react/provider";
import { serverErrorText } from "../../../../core/client/rpc-error";

const blockedKeys = {
  empty: "share.blockedEmpty",
  streaming: "share.blockedStreaming",
  error: "share.blockedError",
} as const;

/** The top bar's Share button and its dialog. */
export function ShareButton({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" aria-label={t("shell.share")} onClick={() => setOpen(true)}>
        <Share2Icon /> <span className="max-sm:hidden">{t("shell.share")}</span>
      </Button>
      <ShareDialog conversationId={conversationId} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Creates, updates or deletes the Conversation's Shared link (ADR 0004). Fetched fresh on every
 * open. While a reply streams, the dialog joins its Run and fetches again once the reply ends, so
 * the link state and the reason sharing is blocked are current (ADR 0006).
 */
export function ShareDialog({
  conversationId,
  open,
  onOpenChange,
}: {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { orpc, shareUrl, chatUrl } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  const statusQuery = orpc.share.forConversation.queryOptions({ input: { conversationId } });
  const status = useQuery({ ...statusQuery, enabled: open, staleTime: 0 });
  const conversationQuery = orpc.conversation.get.queryOptions({ input: { id: conversationId } });
  const conversation = useQuery(conversationQuery);
  const callbacks = {
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
      await invalidateConversationList(queryClient, orpc);
    },
    onError: (error: Error) => toast.error(serverErrorText(i18n, error)),
  };
  const upsert = useMutation(orpc.share.upsert.mutationOptions(callbacks));
  const remove = useMutation(orpc.share.delete.mutationOptions(callbacks));

  const title = conversation.data?.title;
  const link = status.data?.link;
  const blockedBy = status.data?.blockedBy;

  // The reply sharing waits for. Its Message id is its Run's id, so the dialog joins the Run.
  const streamingId =
    blockedBy === "streaming"
      ? conversation.data?.messages.find((message) => message.status === "streaming")?.id
      : undefined;
  const joinedRun = useRef<string>(undefined);
  const replyEnded = useEffectEvent(async (runId: string) => {
    try {
      for await (const _chunk of fetchServerSentEvents(chatUrl).joinRun(runId)) {
        // The reply is shown by its own page; the dialog only waits for its end.
      }
    } catch {
      // A failed join ends the wait; the refetch below shows what is left.
    }
    await queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
    await queryClient.invalidateQueries({ queryKey: conversationQuery.queryKey });
  });
  useEffect(() => {
    if (!streamingId || joinedRun.current === streamingId) return;
    joinedRun.current = streamingId;
    void replyEnded(streamingId);
  }, [streamingId]);
  const url = link ? shareUrl(link.token) : "";
  const busy = upsert.isPending || remove.isPending;
  const canShare = status.isSuccess && !blockedBy && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="pr-6 break-words">
            {t("share.title", { title: title ?? t("shell.untitled") })}
          </DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>

        {status.isError && (
          <p role="alert" className="text-destructive">
            {t("share.loadFailed", { message: serverErrorText(i18n, status.error) })}
          </p>
        )}

        {blockedBy && (
          <p
            role="status"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
          >
            {t(blockedKeys[blockedBy])}
          </p>
        )}

        {link ? (
          <>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
                <Link2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate font-mono">{url}</span>
                <CopyButton text={url} />
              </div>
              <p className="text-[10px] text-muted-foreground">
                {t("share.sharedAgo", { time: relativeTime(i18n, link.updatedAt) })}
                {status.data?.movedOn && ` ${t("share.movedOn")}`}
              </p>
            </div>
            <div className="flex justify-between gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => remove.mutate({ conversationId })}
              >
                {t("share.deleteLink")}
              </Button>
              <div className="flex gap-2">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {t("share.preview")}
                </a>
                <Button
                  size="sm"
                  disabled={!canShare}
                  onClick={() => upsert.mutate({ conversationId })}
                >
                  {t("share.updateLink")}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!canShare}
              onClick={() => upsert.mutate({ conversationId })}
            >
              <Link2Icon /> {t("share.createLink")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error(t("share.copyFailed"));
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? t("share.copied") : t("share.copyLink")}
      title={t("share.copyLink")}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
