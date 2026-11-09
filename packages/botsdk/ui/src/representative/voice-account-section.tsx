import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  maxVoiceGreetingLength,
  type ChannelAccountsView,
  type HeldChannelAccountView,
} from "@botsdk/representative/client";
import {
  useConnectVoiceAccount,
  useRegenerateVoiceSecret,
  useSetVoiceGreeting,
  useRemoveChannelAccount,
} from "@botsdk/representative/react";

/**
 * A Representative's phone calls (ticket #1381, ADR 0036): a voice account is a number and a greeting.
 * The setup shows the hook URL for the Voice agent, a short checklist, and whether an SMS account on the
 * same number is paired. Its secret is shown once, when it is made or regenerated, and then never.
 * The owner turns calls on with a checkbox under the SMS account, as the settings verdict on #1366 has it.
 */
export function VoiceAccountSection({
  id,
  accounts,
  onView,
}: {
  id: string;
  accounts: HeldChannelAccountView[];
  onView: (view: ChannelAccountsView) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [taking, setTaking] = useState(false);
  // Each account's secret, kept only while this page shows it: the server never sends it again.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const refused = (error: unknown) => toast.error(serverErrorText(i18n, error));
  const voice = accounts.filter(({ platform }) => platform === "voice");
  const sms = accounts.find(({ platform }) => platform === "sms");
  const remove = useRemoveChannelAccount({
    onSuccess: (view) => {
      onView(view);
      toast.success(t("representative.channelAccountRemoved"));
    },
    onError: refused,
  });

  return (
    <section data-representative-voice="" className="space-y-2">
      <h3 className="text-sm font-medium">{t("representative.voiceTitle")}</h3>
      <p className="text-xs text-muted-foreground">{t("representative.voiceHelp")}</p>
      {voice.length === 0 && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={taking}
            onChange={(event) => setTaking(event.target.checked)}
          />
          {t("representative.voiceTake")}
        </label>
      )}
      {voice.length === 0 && taking && (
        <VoiceForm
          id={id}
          number={sms?.handle ?? ""}
          onDone={(view, secret) => {
            onView(view);
            const made = view.accounts.find(({ platform }) => platform === "voice");
            if (made) setSecrets((all) => ({ ...all, [made.id]: secret }));
            setTaking(false);
          }}
          onCancel={() => setTaking(false)}
        />
      )}
      {voice.map((account) => (
        <div
          key={account.id}
          data-voice-account=""
          className="space-y-2 rounded-lg border p-3 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {t("representative.voiceNumberLabel", { number: account.handle })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id, channelAccountId: account.id })}
            >
              {t("representative.voiceRemove")}
            </Button>
          </div>
          {account.voice && (
            <>
              <GreetingRow
                id={id}
                channelAccountId={account.id}
                greeting={account.voice.greeting}
                onView={onView}
              />
              <p className="text-xs text-muted-foreground">
                {account.voice.smsPaired
                  ? t("representative.voicePaired")
                  : t("representative.voiceNotPaired")}
              </p>
              <p data-voice-last-call="" className="text-xs text-muted-foreground">
                <LastCall at={account.voice.lastCallAt} />
              </p>
              {account.voice.hookUrl ? (
                <div className="space-y-1">
                  <Input
                    readOnly
                    aria-label={t("representative.voiceHookUrl")}
                    className="font-mono text-xs"
                    value={account.voice.hookUrl}
                    onFocus={(event) => event.target.select()}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("representative.voiceHookUrlHelp")}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("representative.voiceNoHookUrl")}
                </p>
              )}
            </>
          )}
          {secrets[account.id] && (
            <div className="space-y-1">
              <Input
                readOnly
                aria-label={t("representative.voiceSecret")}
                className="font-mono text-xs"
                value={secrets[account.id]}
                onFocus={(event) => event.target.select()}
              />
              <p role="status" className="text-xs text-muted-foreground">
                {t("representative.voiceSecretOnce")}
              </p>
            </div>
          )}
          <RegenerateSecret
            id={id}
            channelAccountId={account.id}
            onDone={(view, secret) => {
              onView(view);
              setSecrets((all) => ({ ...all, [account.id]: secret }));
            }}
          />
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t("representative.voiceChecklist")}</summary>
            <ol className="mt-1 list-decimal space-y-1 pl-5">
              <li>{t("representative.voiceCheck1")}</li>
              <li>{t("representative.voiceCheck2")}</li>
              <li>{t("representative.voiceCheck3")}</li>
            </ol>
          </details>
        </div>
      ))}
    </section>
  );
}

/** How long ago `at` was, in the largest whole unit up to days. */
function ago(at: Date, locale: string) {
  const minutes = Math.round((at.getTime() - Date.now()) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (minutes > -60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours > -24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

/** "Last call 2 hours ago": the signal that a Voice agent is connected and working. */
function LastCall({ at }: { at: Date | null }) {
  const { t, locale } = useI18n();
  if (!at) return <>{t("representative.voiceNoCalls")}</>;
  if (Date.now() - at.getTime() < 60_000) return <>{t("representative.voiceLastCallJustNow")}</>;
  return <>{t("representative.voiceLastCall", { when: ago(at, locale) })}</>;
}

/** The greeting, with an edit in place: the secret and number stay, so the Voice agent keeps working. */
function GreetingRow({
  id,
  channelAccountId,
  greeting,
  onView,
}: {
  id: string;
  channelAccountId: string;
  greeting: string;
  onView: (view: ChannelAccountsView) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(greeting);
  const save = useSetVoiceGreeting({
    onSuccess: (view) => {
      toast.success(t("representative.voiceGreetingSaved"));
      onView(view);
      setEditing(false);
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          {t("representative.voiceGreetingFor", { greeting })}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            setValue(greeting);
            setEditing(true);
          }}
        >
          {t("representative.voiceGreetingChange")}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) save.mutate({ id, channelAccountId, greeting: value });
      }}
    >
      <Input
        type="text"
        autoComplete="off"
        aria-label={t("representative.voiceGreeting")}
        maxLength={maxVoiceGreetingLength}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {t("representative.voiceGreetingSave")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.isPending}
          onClick={() => setEditing(false)}
        >
          {t("representative.voiceCancel")}
        </Button>
      </div>
    </form>
  );
}

/** The number, prefilled from the SMS account's, and the greeting: the only things a voice account takes. */
function VoiceForm({
  id,
  number: given,
  onDone,
  onCancel,
}: {
  id: string;
  number: string;
  onDone: (view: ChannelAccountsView, secret: string) => void;
  onCancel: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [number, setNumber] = useState(given);
  const [greeting, setGreeting] = useState("");
  const connect = useConnectVoiceAccount({
    onSuccess: ({ view, secret }) => {
      toast.success(t("representative.voiceConnected"));
      onDone(view, secret);
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    connect.mutate({ id, number, ...(greeting.trim() && { greeting }) });
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border p-3">
      <Input
        type="text"
        autoComplete="off"
        aria-label={t("representative.voiceNumber")}
        placeholder="+15551234567"
        value={number}
        onChange={(event) => setNumber(event.target.value)}
      />
      <Input
        type="text"
        autoComplete="off"
        aria-label={t("representative.voiceGreeting")}
        placeholder={t("representative.voiceGreeting")}
        maxLength={maxVoiceGreetingLength}
        value={greeting}
        onChange={(event) => setGreeting(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t("representative.voiceGreetingHelp")}</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={connect.isPending || !number.trim()}>
          {t("representative.voiceConnect")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("representative.voiceCancel")}
        </Button>
      </div>
    </form>
  );
}

/** Regenerating asks first: the old secret stops at once, and the Voice agent needs the new one. */
function RegenerateSecret({
  id,
  channelAccountId,
  onDone,
}: {
  id: string;
  channelAccountId: string;
  onDone: (view: ChannelAccountsView, secret: string) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [confirming, setConfirming] = useState(false);
  const regenerate = useRegenerateVoiceSecret({
    onSuccess: ({ view, secret }) => {
      toast.success(t("representative.voiceRegenerated"));
      onDone(view, secret);
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={regenerate.isPending}
        onClick={() => setConfirming(true)}
      >
        {t("representative.voiceRegenerate")}
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("representative.voiceRegenerate")}</DialogTitle>
            <DialogDescription>{t("representative.voiceRegenerateConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              {t("representative.voiceCancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                regenerate.mutate({ id, channelAccountId });
              }}
            >
              {t("representative.voiceRegenerate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
