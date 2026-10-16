import { Button } from "@/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { relativeTime } from "../../../../core/client/relative-time";
import { invalidateConversationList } from "../../../../core/client/react/conversation-list";
import { useChatAdapter, useI18n } from "../../../../core/client/react/provider";
import { serverErrorText } from "../../../../core/client/rpc-error";

/** Settings: every Shared link the user has, with copy and revoke. */
export function SharedLinksSection() {
  const queryClient = useQueryClient();
  const { orpc, shareUrl } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  const links = useQuery(orpc.share.list.queryOptions());
  const remove = useMutation(
    orpc.share.delete.mutationOptions({
      onSuccess: async () => {
        // The list, the Conversation panel's shared flag and every open share dialog.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.share.list.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.share.forConversation.key() }),
          invalidateConversationList(queryClient, orpc),
        ]);
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("settings.sharedLinks")}</h2>
      <p className="text-xs text-muted-foreground">{t("settings.sharedLinksHelp")}</p>
      {links.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.sharedLinksLoadFailed", { message: serverErrorText(i18n, links.error) })}
        </p>
      )}
      {links.isSuccess && links.data.length === 0 && (
        <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
          {t("settings.noSharedLinks")}
        </p>
      )}
      {links.isSuccess && links.data.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {links.data.map((link) => (
            <li key={link.token} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{link.title}</p>
                <p className="text-xs text-muted-foreground">
                  {t("settings.sharedAgo", { time: relativeTime(i18n, link.sharedAt) })}
                </p>
              </div>
              <CopyLinkButton url={shareUrl(link.token)} />
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ conversationId: link.conversationId })}
              >
                {t("settings.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error(t("settings.copyFailed"));
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? t("settings.copied") : t("settings.copyLink")}
      title={t("settings.copyLink")}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
