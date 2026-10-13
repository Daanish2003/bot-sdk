import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "../../core/client/react/provider";
import { serverErrorText } from "../../core/client/rpc-error";

type SavedPrompt = { id: string; name: string; text: string };

/**
 * Settings: the user's Saved prompts, by name. Each is text inserted into the composer by typing
 * its `/name`. Create, edit and delete live here; the server's validation message shows in the form.
 */
export function SavedPromptsSection() {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const list = useQuery(orpc.savedPrompt.list.queryOptions());
  const listKey = orpc.savedPrompt.list.queryKey();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const rows: SavedPrompt[] = list.data?.items ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey });
  const remove = useMutation(
    orpc.savedPrompt.delete.mutationOptions({
      onSuccess: async () => {
        toast.success(t("settings.savedPromptDeleted"));
        await refresh();
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t("settings.savedPrompts")}</h2>
        {!creating && (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            {t("settings.newSavedPrompt")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.savedPromptsHelp")}</p>
      {list.isError && (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.savedPromptsLoadFailed", { message: serverErrorText(i18n, list.error) })}
        </p>
      )}
      {creating && (
        <SavedPromptForm
          onDone={() => setCreating(false)}
          onSaved={refresh}
          submitLabel={t("settings.savePrompt")}
        />
      )}
      {list.isSuccess && rows.length === 0 && !creating && (
        <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
          {t("settings.noSavedPrompts")}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {rows.map((row) =>
            editingId === row.id ? (
              <li key={row.id} className="px-4 py-3">
                <SavedPromptForm
                  initial={row}
                  onDone={() => setEditingId(null)}
                  onSaved={refresh}
                  submitLabel={t("settings.saveChanges")}
                />
              </li>
            ) : (
              <li key={row.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm">/{row.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.text.trim().split("\n")[0]}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => setEditingId(row.id)}
                >
                  {t("settings.edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ id: row.id })}
                >
                  {t("shell.delete")}
                </Button>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** Creates a Saved prompt, or edits `initial`; the server's message for a refused save shows here. */
function SavedPromptForm({
  initial,
  onDone,
  onSaved,
  submitLabel,
}: {
  initial?: SavedPrompt;
  onDone: () => void;
  onSaved: () => Promise<unknown>;
  submitLabel: string;
}) {
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const [name, setName] = useState(initial?.name ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const onSuccess = async () => {
    toast.success(t("settings.savedPromptSaved"));
    await onSaved();
    onDone();
  };
  const create = useMutation(orpc.savedPrompt.create.mutationOptions({ onSuccess }));
  const update = useMutation(orpc.savedPrompt.update.mutationOptions({ onSuccess }));
  const save = initial ? update : create;

  return (
    <form
      className="space-y-3 rounded-xl border px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (initial) update.mutate({ id: initial.id, name, text });
        else create.mutate({ name, text });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`saved-prompt-name-${initial?.id ?? "new"}`}>
          {t("settings.savedPromptName")}
        </Label>
        <Input
          id={`saved-prompt-name-${initial?.id ?? "new"}`}
          value={name}
          placeholder={t("settings.savedPromptNamePlaceholder")}
          className="font-mono"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`saved-prompt-text-${initial?.id ?? "new"}`}>
          {t("settings.savedPromptText")}
        </Label>
        <Textarea
          id={`saved-prompt-text-${initial?.id ?? "new"}`}
          value={text}
          placeholder={t("settings.savedPromptTextPlaceholder")}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      {save.error && (
        <p role="alert" className="text-xs text-destructive">
          {serverErrorText(i18n, save.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("settings.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? t("settings.saving") : submitLabel}
        </Button>
      </div>
    </form>
  );
}
