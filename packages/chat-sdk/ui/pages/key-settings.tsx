import {
  type CredentialService,
  credentialForms,
  type SaveCredentialsInput,
} from "../../core/shared/credentials/services";
import {
  type ProviderRow,
  type ProviderRowStatus,
  providerRows,
  type ToolRow,
  toolRows,
} from "../../core/client/key-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useByok } from "../../core/client/react/byok";
import { type ChatOrpc, useOrpc } from "../../core/client/react/provider";
import { ConnectionsSection } from "../settings/connections-section";
import { DeleteAllConversationsSection } from "../settings/delete-all-conversations";
import { ExportDataButton } from "../settings/export-data-button";
import { InstructionsField } from "../settings/instructions-field";
import { SharedLinksSection } from "../settings/shared-links";
import { TitleModelSelect } from "../settings/title-model-select";

/**
 * Keys & settings: the user's Provider and Tool credentials, the Title Model and the Instructions.
 * With `byok` off the credential sections are left out; the settings stay.
 */
export function KeySettingsPage() {
  const orpc = useOrpc();
  const byok = useByok();
  const credentials = useQuery(orpc.credentials.list.queryOptions());
  const [editing, setEditing] = useState<CredentialService | null>(null);
  const rows = providerRows(credentials.data ?? []);

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Keys & settings</h1>
        {byok && (
          <p className="text-sm text-muted-foreground">
            Bring your own Provider credentials. Keys are encrypted on the server and never shown
            again; you only see the last characters.
          </p>
        )}
      </div>

      {byok && (
        <>
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Providers</h2>
            <ul className="divide-y overflow-hidden rounded-xl border">
              {rows.map((row) => (
                <ProviderRowItem
                  key={row.id}
                  row={row}
                  loading={credentials.isPending}
                  editing={row.service !== null && editing === row.service}
                  onEdit={setEditing}
                  onDone={() => setEditing(null)}
                />
              ))}
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">Tools</h2>
            <p className="text-xs text-muted-foreground">
              Tool credentials for features beyond chat. Without a Tavily key, web search is off.
            </p>
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
      )}

      <ConnectionsSection />

      <SharedLinksSection />

      <InstructionsField />

      <TitleModelSelect />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Your data</h2>
        <p className="text-xs text-muted-foreground">
          Download your Projects, Conversations, Messages, settings and Shared links as one JSON
          file. Keys are never included.
        </p>
        <ExportDataButton />
      </section>

      <DeleteAllConversationsSection />
    </main>
  );
}

const statusDot: Record<ProviderRowStatus, { className: string; label: string }> = {
  verified: { className: "bg-green-500", label: "Verified" },
  unverified: { className: "bg-amber-500", label: "Saved, not verified" },
  missing: { className: "bg-muted-foreground/40", label: "No credentials" },
  coming_soon: { className: "bg-muted-foreground/20", label: "Coming soon" },
};

function ProviderRowItem({
  row,
  loading,
  editing,
  onEdit,
  onDone,
}: {
  row: ProviderRow | ToolRow;
  loading: boolean;
  editing: boolean;
  onEdit: (service: CredentialService) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const remove = useMutation(
    orpc.credentials.delete.mutationOptions({
      onSuccess: () => invalidateCredentials(queryClient, orpc),
      onError: (error) => toast.error(error.message),
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
          aria-label={dot.label}
          title={dot.label}
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
          <span className="text-xs text-muted-foreground">Coming soon</span>
        ) : (
          <>
            {row.hint && (
              <span className="font-mono text-xs text-muted-foreground">{row.hint}</span>
            )}
            {row.status !== "missing" && (
              <span className="text-xs text-muted-foreground">
                {row.status === "verified" ? "Verified" : "Not verified"}
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
                  {row.status === "missing" ? "Add" : "Replace"}
                </Button>
                {row.status !== "missing" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ service })}
                  >
                    Delete
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {service && editing && <CredentialForm service={service} onDone={onDone} />}
    </li>
  );
}

/** Saved or deleted credentials change the Key settings rows and which Models can be picked. */
function invalidateCredentials(queryClient: QueryClient, orpc: ChatOrpc) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.credentials.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.models.key() }),
  ]);
}

function CredentialForm({ service, onDone }: { service: CredentialService; onDone: () => void }) {
  const form = credentialForms[service];
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((field) => [field.name, ""])),
  );
  const save = useMutation(
    orpc.credentials.save.mutationOptions({
      onSuccess: async (saved) => {
        await invalidateCredentials(queryClient, orpc);
        toast.success(saved.verified ? "Credentials checked and saved" : "Saved, not verified");
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
          {save.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!filled || save.isPending}>
          {save.isPending ? "Checking…" : "Check & save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
