import {
  type CredentialService,
  credentialForms,
  type SaveCredentialsInput,
} from "@botsdk/client/models/credentials/services";

import {
  type ProviderRow,
  type ProviderRowStatus,
  providerRows,
  type ToolRow,
  toolRows,
} from "./key-rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import type { MessageKey } from "@botsdk/client/i18n";
import { useByok } from "@botsdk/react/models/byok";
import { type BotSdkOrpc, useI18n, useOrpc } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";

/**
 * What the Host provides for linked credentials (ADR 0023): how a user links and unlinks their
 * ChatGPT plan. The Bot SDK has no auth, so the Host owns both.
 */
export type LinkedCredentialsHost = {
  /** Starts linking ChatGPT; the Host's auth takes the browser away and returns to the Keys page. */
  connect: () => void | Promise<void>;
  disconnect: () => void | Promise<void>;
};

/**
 * Keys & settings: the heading and intro, then the sections the Host passes (this plugin's
 * `CredentialsSections` and other plugins' settings). The page imports no other plugin's UI.
 */
export function KeySettingsPage({ children }: { children?: ReactNode }) {
  const byok = useByok();
  const { t } = useI18n();

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{t("shell.keysAndSettings")}</h1>
        {byok && <p className="text-sm text-muted-foreground">{t("pages.keysIntro")}</p>}
      </div>

      {children}
    </main>
  );
}

/** The Providers and Tools sections: the user's credentials. Left out with `byok` off. */
export function CredentialsSections({
  linkedCredentials,
}: {
  linkedCredentials?: LinkedCredentialsHost;
}) {
  const orpc = useOrpc();
  const byok = useByok();
  const { t } = useI18n();
  const credentials = useQuery(orpc.models.credentials.list.queryOptions());
  const [editing, setEditing] = useState<CredentialService | null>(null);
  const rows = providerRows(credentials.data ?? []);

  if (!byok) return null;
  return (
    <>
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("pages.providers")}</h2>
        <ul className="divide-y overflow-hidden rounded-xl border">
          {rows.map((row) => (
            <ProviderRowItem
              key={row.id}
              row={row}
              loading={credentials.isPending}
              linkedCredentials={row.id === "openai" ? linkedCredentials : undefined}
              editing={row.service !== null && editing === row.service}
              onEdit={setEditing}
              onDone={() => setEditing(null)}
            />
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("pages.tools")}</h2>
        <p className="text-xs text-muted-foreground">{t("pages.toolsHelp")}</p>
        <ul className="divide-y overflow-hidden rounded-xl border">
          {toolRows(credentials.data ?? []).map((row) => (
            <ProviderRowItem
              key={row.id}
              row={row}
              loading={credentials.isPending}
              editing={editing === row.service}
              onEdit={setEditing}
              onDone={() => setEditing(null)}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

const statusDot: Record<ProviderRowStatus, { className: string; label: MessageKey }> = {
  verified: { className: "bg-green-500", label: "pages.verified" },
  unverified: { className: "bg-amber-500", label: "pages.unverified" },
  missing: { className: "bg-muted-foreground/40", label: "pages.noCredentials" },
  coming_soon: { className: "bg-muted-foreground/20", label: "pages.comingSoon" },
};

function ProviderRowItem({
  row,
  loading,
  linkedCredentials,
  editing,
  onEdit,
  onDone,
}: {
  row: ProviderRow | ToolRow;
  loading: boolean;
  linkedCredentials?: LinkedCredentialsHost;
  editing: boolean;
  onEdit: (service: CredentialService) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const remove = useMutation(
    orpc.models.credentials.delete.mutationOptions({
      onSuccess: () => invalidateCredentials(queryClient, orpc),
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const dot = statusDot[row.status];
  const service = row.service;

  return (
    <li className="space-y-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <span
          className={cn("size-2 shrink-0 rounded-full", dot.className)}
          role="img"
          aria-label={t(dot.label)}
          title={t(dot.label)}
        />
        <span className="flex-1 text-sm font-medium">
          {row.label}
          {"description" in row && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {row.description}
            </span>
          )}
        </span>

        {row.status === "coming_soon" ? (
          <span className="text-xs text-muted-foreground">{t("pages.comingSoon")}</span>
        ) : (
          <>
            {row.hint && (
              <span className="font-mono text-xs text-muted-foreground">{row.hint}</span>
            )}
            {row.status !== "missing" && (
              <span className="text-xs text-muted-foreground">
                {row.status === "verified" ? t("pages.verified") : t("pages.notVerified")}
              </span>
            )}
            {service && !editing && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading}
                  onClick={() => onEdit(service)}
                >
                  {row.status === "missing" ? t("pages.add") : t("pages.replace")}
                </Button>
                {row.status !== "missing" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ service })}
                  >
                    {t("pages.delete")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {linkedCredentials && <ChatgptLink host={linkedCredentials} />}

      {service && editing && <CredentialForm service={service} onDone={onDone} />}
    </li>
  );
}

/** The OpenAI row's ChatGPT plan, by `models.credentials.openaiState`: a saved key wins over a link. */
function ChatgptLink({ host }: { host: LinkedCredentialsHost }) {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const state = useQuery(orpc.models.credentials.openaiState.queryOptions());
  const connect = useMutation({
    mutationFn: () => Promise.resolve(host.connect()),
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const disconnect = useMutation({
    mutationFn: () => Promise.resolve(host.disconnect()),
    onSuccess: () => invalidateCredentials(queryClient, orpc),
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });

  if (!state.data) return null;
  return (
    <div className="flex items-center gap-3 pl-5 text-xs text-muted-foreground">
      {state.data === "key" && <span>{t("pages.chatgptKeyWins")}</span>}
      {state.data === "linked" && (
        <>
          <span className="flex-1">{t("pages.chatgptConnected")}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
          >
            {t("pages.chatgptReconnect")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {t("pages.chatgptDisconnect")}
          </Button>
        </>
      )}
      {state.data === "needs-reconnect" && (
        <>
          <span className="flex-1">{t("pages.chatgptNeedsReconnect")}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
          >
            {t("pages.chatgptReconnect")}
          </Button>
        </>
      )}
      {state.data === "none" && (
        <Button
          size="sm"
          variant="outline"
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
        >
          {t("pages.chatgptConnect")}
        </Button>
      )}
    </div>
  );
}

/** Saved or deleted credentials change the Key settings rows and which Models can be picked. */
function invalidateCredentials(queryClient: QueryClient, orpc: BotSdkOrpc) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.models.credentials.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.models.key() }),
  ]);
}

function CredentialForm({ service, onDone }: { service: CredentialService; onDone: () => void }) {
  const form = credentialForms[service];
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((field) => [field.name, ""])),
  );
  const save = useMutation(
    orpc.models.credentials.save.mutationOptions({
      onSuccess: async (saved) => {
        await invalidateCredentials(queryClient, orpc);
        toast.success(saved.verified ? t("pages.credentialsChecked") : t("pages.unverified"));
        onDone();
      },
    }),
  );
  const filled = form.fields.every((field) => values[field.name]?.trim());

  return (
    <form
      className="space-y-3 pl-5"
      onSubmit={(event) => {
        event.preventDefault();
        // The server validates the fields against the service's schema.
        save.mutate({ service, fields: values } as SaveCredentialsInput);
      }}
    >
      <p className="text-xs text-muted-foreground">{form.helpText}</p>
      {form.fields.map((field) => {
        const id = `${service}-${field.name}`;
        return (
          <div key={field.name} className="space-y-1">
            <Label htmlFor={id}>{field.label}</Label>
            <Input
              id={id}
              type={field.visible ? "text" : "password"}
              autoComplete="off"
              placeholder={field.placeholder}
              value={values[field.name] ?? ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.target.value }))
              }
            />
          </div>
        );
      })}
      {save.error && (
        <p role="alert" className="text-xs text-destructive">
          {serverErrorText(i18n, save.error)}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!filled || save.isPending}>
          {save.isPending ? t("pages.checking") : t("pages.checkAndSave")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("pages.cancel")}
        </Button>
      </div>
    </form>
  );
}
