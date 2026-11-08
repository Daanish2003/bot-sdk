import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import type {
  ChannelAccountPlatformView,
  ChannelAccountsView,
} from "@botsdk/representative/client";
import {
  useChannelAccounts,
  useConnectChannelAccount,
  useRemoveChannelAccount,
  useStoreChannelAccounts,
} from "@botsdk/representative/react";

/**
 * A Representative's Channel accounts (ticket #1358, ADR 0033): the owner connects a platform's
 * number or bot with its credentials, sees what is connected, and removes it. The form is the
 * platform's own fields, so it fits any messaging platform the Host offers. Nothing shows when the
 * Host offers none.
 */
export function ChannelAccountsSection({ id }: { id: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const accounts = useChannelAccounts(id);
  const store = useStoreChannelAccounts(id);
  const [connecting, setConnecting] = useState<string | null>(null);
  const refused = (error: unknown) => toast.error(serverErrorText(i18n, error));
  const remove = useRemoveChannelAccount({
    onSuccess: (view) => {
      store(view);
      toast.success(t("representative.channelAccountRemoved"));
    },
    onError: refused,
  });

  if (accounts.data === undefined && accounts.isError) {
    return (
      <p className="text-sm text-destructive">{t("representative.channelAccountLoadFailed")}</p>
    );
  }
  if (!accounts.data || accounts.data.platforms.length === 0) return null;
  const { platforms, accounts: held } = accounts.data;
  return (
    <section data-representative-channel-accounts="" className="space-y-2">
      <h2 className="text-sm font-medium">{t("representative.channelAccounts")}</h2>
      <p className="text-xs text-muted-foreground">{t("representative.channelAccountsHelp")}</p>
      {held.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("representative.channelAccountNone")}</p>
      ) : (
        <ul aria-label={t("representative.channelAccounts")} className="space-y-2 text-sm">
          {held.map((account) => (
            <li
              key={account.id}
              data-channel-account={account.platform}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="font-medium">
                {t("representative.channelAccountPlatform", { platform: account.platform })}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{account.handle}</span>
              {account.status === "needs_attention" && (
                <span role="alert" className="flex items-center gap-1 text-xs text-destructive">
                  <TriangleAlertIcon aria-hidden className="size-4" />
                  {t("representative.channelAccountNeedsAttention", {
                    reason: account.reason ?? "",
                  })}
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                aria-label={t("representative.channelAccountRemoveFor", {
                  handle: account.handle,
                })}
                disabled={remove.isPending}
                onClick={() => remove.mutate({ id, channelAccountId: account.id })}
              >
                {t("representative.channelAccountRemove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {platforms.map(({ platform }) => (
          <Button
            key={platform}
            type="button"
            variant="outline"
            size="sm"
            disabled={connecting === platform}
            onClick={() => setConnecting(platform)}
          >
            {t("representative.channelAccountConnect", {
              platform: t("representative.channelAccountPlatform", { platform }),
            })}
          </Button>
        ))}
      </div>
      {platforms
        .filter(({ platform }) => platform === connecting)
        .map((platform) => (
          <ConnectForm
            key={platform.platform}
            id={id}
            platform={platform}
            onDone={(view) => {
              store(view);
              setConnecting(null);
            }}
            onCancel={() => setConnecting(null)}
          />
        ))}
    </section>
  );
}

/** The credentials a platform takes, one password field each, checked with the platform on connect. */
function ConnectForm({
  id,
  platform,
  onDone,
  onCancel,
}: {
  id: string;
  platform: ChannelAccountPlatformView;
  onDone: (view: ChannelAccountsView) => void;
  onCancel: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [values, setValues] = useState<Record<string, string>>({});
  const connect = useConnectChannelAccount({
    onSuccess: (view) => {
      toast.success(t("representative.channelAccountConnected"));
      onDone(view);
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    connect.mutate({ id, platform: platform.platform, credentials: values });
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border p-3">
      {platform.fields.map((field) => (
        <Input
          key={field}
          type="password"
          autoComplete="off"
          aria-label={t("representative.channelAccountField", { field })}
          placeholder={t("representative.channelAccountField", { field })}
          value={values[field] ?? ""}
          onChange={(event) => setValues({ ...values, [field]: event.target.value })}
        />
      ))}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={connect.isPending || platform.fields.some((field) => !values[field]?.trim())}
        >
          {t("representative.channelAccountSave")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("representative.widgetKeyCancel")}
        </Button>
      </div>
    </form>
  );
}
