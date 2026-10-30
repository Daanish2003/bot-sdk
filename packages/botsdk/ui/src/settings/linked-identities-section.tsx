import { Button } from "@/components/ui/button";
import type { ChannelsContract } from "@botsdk/client/bot/contract";
import type { LinkedIdentityRow } from "@botsdk/client/bot/linked-identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { LinkCodeView } from "../channel/link-code-view";
import { useI18n, useOrpc } from "@botsdk/react/provider";

/**
 * The Linked identities section (spec #1044), beside Notifications: the messaging accounts the
 * user proved are theirs, each with Unlink, and **Get a link code** with its expiry and deep links.
 * Renders nothing while the Host offers no messaging Channel (the list is not served).
 */
export function LinkedIdentitiesSection() {
  const { t } = useI18n();
  const orpc = useOrpc<{ channels: ChannelsContract }>();
  const queryClient = useQueryClient();
  const listQuery = orpc.channels.identities.list.queryOptions();
  const list = useQuery({ ...listQuery, retry: false });
  const unlink = useMutation(
    orpc.channels.identities.unlink.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: listQuery.queryKey }),
      onError: () => toast.error(t("settings.unlinkFailed")),
    }),
  );
  const code = useMutation(orpc.channels.identities.linkCode.mutationOptions());
  if (!list.data) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("settings.linkedIdentities")}</h2>
      <p className="text-xs text-muted-foreground">{t("settings.linkedIdentitiesHelp")}</p>
      <div className="space-y-3 rounded-xl border px-4 py-3">
        {list.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.noLinkedIdentities")}</p>
        ) : (
          <ul aria-label={t("settings.linkedIdentities")} className="space-y-1">
            {list.data.map((identity) => (
              <IdentityRow
                key={identity.platform}
                identity={identity}
                pending={unlink.isPending}
                onUnlink={() => unlink.mutate({ platform: identity.platform })}
              />
            ))}
          </ul>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={code.isPending}
          onClick={() => code.mutate(undefined)}
        >
          {t("settings.getLinkCode")}
        </Button>
        {code.data && <LinkCodeView issued={code.data} />}
      </div>
    </section>
  );
}

function IdentityRow({
  identity,
  pending,
  onUnlink,
}: {
  identity: LinkedIdentityRow;
  pending: boolean;
  onUnlink: () => void;
}) {
  const { t } = useI18n();
  const platform = t("bots.channelPlatform", { platform: identity.platform });
  return (
    <li className="flex items-center gap-2 text-sm">
      <span>{t("settings.linkedIdentityLine", { platform, handle: identity.handle })}</span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="ml-auto"
        aria-label={t("settings.unlinkIdentityLabel", { platform })}
        disabled={pending}
        onClick={onUnlink}
      >
        {t("settings.unlinkIdentity")}
      </Button>
    </li>
  );
}
