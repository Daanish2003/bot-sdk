import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useOrpc } from "../../core/client/react/provider";

type SavedPrompt = { id: string; name: string; text: string };

/**
 * Settings: the user's Saved prompts, by name. Each is text inserted into the composer by typing
 * its `/name`. Create, edit and delete live here; the server's validation message shows in the form.
 */
export function SavedPromptsSection() {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const list = useQuery(orpc.savedPrompt.list.queryOptions());
  const listKey = orpc.savedPrompt.list.queryKey();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const rows: SavedPrompt[] = list.data?.items ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey });
  const remove = useMutation(
    orpc.savedPrompt.delete.mutationOptions({
      onSuccess: async () => {
        toast.success("Saved prompt deleted");
        await refresh();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Saved prompts</h2>
        {!creating && (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            New Saved prompt
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Text you send often. Insert one into the composer by typing its /name, then edit it before
        sending. Nothing is sent by itself.
      </p>
      {list.isError && (
        <p role="alert" className="text-xs text-destructive">
          Couldn't load your Saved prompts: {list.error.message}
        </p>
      )}
      {creating && (
        <SavedPromptForm
          onDone={() => setCreating(false)}
          onSaved={refresh}
          submitLabel="Save prompt"
        />
      )}
      {list.isSuccess && rows.length === 0 && !creating && (
        <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
          You haven't saved any Saved prompts yet.
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
                  submitLabel="Save changes"
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
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ id: row.id })}
                >
                  Delete
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
  const [name, setName] = useState(initial?.name ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const onSuccess = async () => {
    toast.success("Saved prompt saved");
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
        <Label htmlFor={`saved-prompt-name-${initial?.id ?? "new"}`}>Name</Label>
        <Input
          id={`saved-prompt-name-${initial?.id ?? "new"}`}
          value={name}
          placeholder="review"
          className="font-mono"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`saved-prompt-text-${initial?.id ?? "new"}`}>Text</Label>
        <Textarea
          id={`saved-prompt-text-${initial?.id ?? "new"}`}
          value={text}
          placeholder="Review this code for bugs first, then suggest fixes."
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      {save.error && (
        <p role="alert" className="text-xs text-destructive">
          {save.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
