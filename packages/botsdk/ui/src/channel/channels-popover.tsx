import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChannelAccountRow } from "@botsdk/client/bot/channel-account";
import type { ChannelsContract } from "@botsdk/client/bot/contract";
import type { LinkCode } from "@botsdk/client/bot/linked-identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquareIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "@botsdk/react/provider";

import { LinkCodeView } from "./link-code-view";
import { serverErrorText } from "@botsdk/react/rpc-error";

/**
 * The Bot header's **Channels** button (spec #1044, Bot settings prototype variant A), beside
 * Email: a popover with a row per messaging platform the Host offers. A row shows **Add**, which
 * opens an inline password-type field with a one-line setup hint; or the Bot's account's handle
 * with a remove button; or, when the platform rejected the credentials, a warning (repeated on the
 * button), the reason and **Fix**. Render it only when the Host's `channels` slot has a messaging
 * adapter.
 */
export function ChannelsPopover({ botId }: { botId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc<{ channels: ChannelsContract }>();
  const listQuery = orpc.channels.accounts.list.queryOptions({ input: { botId } });
  const list = useQuery(listQuery);
  const needsAttention = list.data?.some((row) => row.account?.status === "needs_attention");

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <MessagesSquareIcon /> {t("bots.channels")}
        {needsAttention && (
          <TriangleAlertIcon
            role="img"
            aria-label={t("bots.channelsNeedAttention")}
            className="text-destructive"
          />
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-96 flex-col gap-3">
        {list.data ? (
          <ul aria-label={t("bots.channels")} className="flex flex-col gap-3 text-sm">
            {list.data.map((row) => (
              <PlatformRow
                key={row.platform}
                botId={botId}
                row={row}
                listKey={listQuery.queryKey}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            {list.error ? serverErrorText(i18n, list.error) : t("bots.channelsLoading")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One platform's row: Add, the connected handle with remove, or needs attention with Fix. */
function PlatformRow({
  botId,
  row,
  listKey,
}: {
  botId: string;
  row: ChannelAccountRow;
  listKey: readonly unknown[];
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc<{ channels: ChannelsContract }>();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [linkCode, setLinkCode] = useState<LinkCode | null>(null);
  const save = useMutation(orpc.channels.accounts.save.mutationOptions());
  const remove = useMutation(orpc.channels.accounts.remove.mutationOptions());
  const refused = (error: unknown) => toast.error(serverErrorText(i18n, error));
  const platform = t("bots.channelPlatform", { platform: row.platform });
  const replaceRow = (next: ChannelAccountRow) =>
    queryClient.setQueryData(listKey, (shown: ChannelAccountRow[] | undefined) =>
      shown?.map((entry) => (entry.platform === next.platform ? next : entry)),
    );

  // "Now link yourself": a code, when the user has no Linked identity on this platform yet. A
  // Host that can't say (no identities served) is left alone.
  const offerLink = async () => {
    try {
      const linked = await queryClient.fetchQuery(orpc.channels.identities.list.queryOptions());
      if (linked.some((identity) => identity.platform === row.platform)) return;
      setLinkCode(await orpc.channels.identities.linkCode.call());
    } catch {}
  };

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { botId, platform: row.platform, credentials: values },
      {
        onSuccess: (saved) => {
          replaceRow(saved);
          // The platform bot may have moved here from another Bot, whose list is now stale.
          void queryClient.invalidateQueries({ queryKey: orpc.channels.accounts.list.key() });
          setEditing(false);
          setValues({});
          void offerLink();
        },
        onError: refused,
      },
    );
  };
  const onRemove = () =>
    remove.mutate(
      { botId, platform: row.platform },
      { onSuccess: () => replaceRow({ ...row, account: null }), onError: refused },
    );

  const attention = row.account?.status === "needs_attention" ? row.account : null;
  return (
    <li data-platform={row.platform} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="font-medium">{platform}</span>
        {row.account && <span className="text-xs text-muted-foreground">{row.account.handle}</span>}
        {attention && <TriangleAlertIcon aria-hidden className="size-4 text-destructive" />}
        <span className="ml-auto flex gap-1">
          {!editing && (!row.account || attention) && (
            <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
              {t(attention ? "bots.channelFix" : "bots.channelAdd")}
            </Button>
          )}
          {row.account && (
            <Button
              size="xs"
              variant="ghost"
              aria-label={t("bots.channelRemove", { platform })}
              disabled={remove.isPending}
              onClick={onRemove}
            >
              {t("bots.channelRemoveShort")}
            </Button>
          )}
        </span>
      </div>
      {attention && (
        <p role="alert" className="text-xs text-destructive">
          {t("bots.channelNeedsAttention", { reason: attention.reason ?? "" })}
        </p>
      )}
      {linkCode && !editing && row.account && (
        <div className="flex flex-col gap-1 rounded-lg border p-2">
          <p className="font-medium">{t("bots.channelLinkYourself")}</p>
          <p className="text-xs text-muted-foreground">
            {t("bots.channelLinkYourselfHelp", { platform })}
          </p>
          <LinkCodeView issued={linkCode} botId={botId} />
        </div>
      )}
      {editing && (
        <form onSubmit={onSave} className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {t("bots.channelSetupHint", { platform: row.platform })}
          </p>
          {row.fields.map((field) => (
            <Input
              key={field}
              type="password"
              autoComplete="off"
              aria-label={t("bots.channelField", { field })}
              placeholder={t("bots.channelField", { field })}
              value={values[field] ?? ""}
              onChange={(event) => setValues({ ...values, [field]: event.target.value })}
            />
          ))}
          <div className="flex gap-2">
            <Button
              size="xs"
              type="submit"
              disabled={save.isPending || row.fields.some((field) => !values[field]?.trim())}
            >
              {t("bots.channelSave")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              type="button"
              onClick={() => {
                setEditing(false);
                setValues({});
              }}
            >
              {t("bots.cancel")}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
