import { Button } from "@/components/ui/button";
import { plainText } from "@botsdk/client/message-format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useI18n, useOrpc } from "@botsdk/react/provider";

/**
 * The Pages waiting for the user (ticket #1300), each with Acknowledge, which stops whatever it
 * hasn't sent yet. Renders nothing with none waiting.
 */
export function PagesSection() {
  const { t } = useI18n();
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  const listQuery = orpc.pages.list.queryOptions();
  const list = useQuery(listQuery);
  const acknowledge = useMutation(
    orpc.pages.acknowledge.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: listQuery.queryKey }),
      onError: () => toast.error(t("settings.acknowledgeFailed")),
    }),
  );
  if (!list.data?.length) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("settings.pages")}</h2>
      <p className="text-xs text-muted-foreground">{t("settings.pagesHelp")}</p>
      <ul aria-label={t("settings.pages")} className="space-y-2 rounded-xl border px-4 py-3">
        {list.data.map((page) => (
          <li key={page.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <a href={page.path} className="block text-sm font-medium break-words hover:underline">
                {page.title}
              </a>
              {page.urgency === "emergency" && (
                <p className="text-xs font-medium text-destructive">
                  {t("settings.pageEmergency")}
                </p>
              )}
              <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
                {plainText(page.text)}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={acknowledge.isPending}
              aria-label={t("settings.acknowledgePage", { title: page.title })}
              onClick={() => acknowledge.mutate({ id: page.id })}
            >
              {t("settings.acknowledge")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
