import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";

import type { SharedConversation } from "../../core/shared/share/conversation";
import { sharedToUIMessages } from "../../core/client/chat";
import { invalidateConversationList } from "../../core/client/react/conversation-list";
import { useChatAdapter, useI18n } from "../../core/client/react/provider";

import { MessageRow } from "../chat/message-row";

/** Whether the viewer is signed in, and where the Host sends a signed-out viewer to sign in. */
export type SharedViewer = { signedIn: boolean; signInUrl: string };

/** "Continue this Conversation": copies the snapshot into the viewer's account and opens it. */
function ContinueConversation({ token, viewer }: { token: string; viewer: SharedViewer }) {
  const { orpc, navigate } = useChatAdapter();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const continueShared = useMutation(orpc.share.continue.mutationOptions());

  if (!viewer.signedIn) {
    return (
      <a href={viewer.signInUrl} className={buttonVariants({ size: "sm" })}>
        {t("pages.continueConversation")}
      </a>
    );
  }

  const start = async () => {
    try {
      const { id } = await continueShared.mutateAsync({ token });
      void invalidateConversationList(queryClient, orpc);
      await navigate({ to: "conversation", id });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("pages.couldntContinue"));
    }
  };

  return (
    <Button size="sm" onClick={() => void start()} disabled={continueShared.isPending}>
      {t("pages.continueConversation")}
    </Button>
  );
}

/** A Shared link's public, read-only page, outside the signed-in layout (ADR 0004). */
export function SharedConversationPage({
  data,
  viewer,
}: {
  data: SharedConversation;
  viewer?: SharedViewer;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="h-full overflow-y-auto bg-background">
      <header className="border-b px-4 py-2 text-xs text-muted-foreground">
        {t("pages.sharedHeader")}
      </header>
      <article className="mx-auto max-w-4xl py-8">
        <div className="px-6 pb-6">
          <h1 className="text-2xl font-semibold tracking-tight">{data.title}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("pages.shared")}{" "}
            <time dateTime={data.sharedAt.toISOString()}>
              {data.sharedAt.toLocaleDateString(locale, { dateStyle: "long" })}
            </time>
          </p>
          {viewer && (
            <div className="mt-4">
              <ContinueConversation token={data.token} viewer={viewer} />
            </div>
          )}
        </div>
        <div className="border-t">
          {sharedToUIMessages(data.messages).map((message) => (
            <MessageRow key={message.id} message={message} userLabel={t("pages.userLabel")} />
          ))}
        </div>
        <footer className="mt-12 text-center text-xs text-muted-foreground">
          {t("pages.sharedFooter")}
        </footer>
      </article>
    </div>
  );
}

export function SharedLinkNotFound() {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-sm font-medium">{t("pages.sharedNotFoundTitle")}</h1>
      <p className="text-xs text-muted-foreground">{t("pages.sharedNotFoundBody")}</p>
    </div>
  );
}
