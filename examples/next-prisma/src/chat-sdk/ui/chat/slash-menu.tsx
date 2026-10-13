import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { PlusIcon } from "lucide-react";
import { type FormEvent, type MouseEvent, useState } from "react";

import {
  firstLine,
  lastRowLabel,
  rankSavedPrompts,
  savedPromptDraftError,
} from "../../core/client/saved-prompts-menu";
import { useOrpc } from "../../core/client/react/provider";

type SavedPromptRow = { name: string; text: string };

/**
 * The `/` menu's rows: one per Saved prompt that matches `query`, then the last row, which creates
 * one. `active` is the highlighted row; the create row's index is the number of matches.
 */
export function SlashMenuList({
  prompts,
  query,
  loaded,
  active,
  onHover,
  onPick,
}: {
  prompts: SavedPromptRow[];
  query: string;
  /** The list has loaded, so an empty list means the user has no Saved prompts yet. */
  loaded: boolean;
  active: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}) {
  const matches = rankSavedPrompts(prompts, query);
  // Clicks keep the textarea's focus; the pick inserts and focuses it.
  const keepFocus = (event: MouseEvent) => event.preventDefault();
  return (
    <div role="listbox" aria-label="Saved prompts" className="max-h-72 overflow-y-auto p-1">
      {loaded && prompts.length === 0 && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          No Saved prompts yet. Save text you send often and insert it with /name.
        </p>
      )}
      {matches.map((prompt, index) => (
        <button
          key={prompt.name}
          type="button"
          role="option"
          aria-selected={index === active}
          onMouseEnter={() => onHover(index)}
          onMouseDown={keepFocus}
          onClick={() => onPick(index)}
          className={cn(
            "flex w-full flex-col rounded-md px-2 py-1.5 text-left",
            index === active && "bg-muted",
          )}
        >
          <span className="text-sm font-medium">/{prompt.name}</span>
          <span className="truncate text-xs text-muted-foreground">{firstLine(prompt.text)}</span>
        </button>
      ))}
      <button
        type="button"
        role="option"
        aria-selected={active === matches.length}
        onMouseEnter={() => onHover(matches.length)}
        onMouseDown={keepFocus}
        onClick={() => onPick(matches.length)}
        className={cn(
          "mt-1 flex w-full items-center gap-2 rounded-md border-t px-2 py-1.5 text-left text-sm",
          active === matches.length && "bg-muted",
        )}
      >
        <PlusIcon className="size-3.5" aria-hidden />
        {lastRowLabel(query, matches.length)}
      </button>
    </div>
  );
}

/**
 * The create form's fields and buttons, without state. `status` is the line under them: the
 * server's message or the reason the draft can't be saved, or a hint when neither applies.
 */
export function SavedPromptFormView({
  name,
  onName,
  text,
  onText,
  status,
  canSave,
  saving,
  onSubmit,
  onCancel,
}: {
  name: string;
  onName: (name: string) => void;
  text: string;
  onText: (text: string) => void;
  status: string;
  canSave: boolean;
  saving: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form className="flex flex-col gap-2 p-3" onSubmit={onSubmit}>
      <span className="text-xs font-medium">New Saved prompt</span>
      <label className="flex items-center gap-1 text-sm">
        <span className="text-muted-foreground">/</span>
        <Input
          aria-label="Name"
          autoFocus
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="name"
          className="h-8"
        />
      </label>
      <Textarea
        aria-label="Text"
        value={text}
        onChange={(event) => onText(event.target.value)}
        rows={5}
        placeholder="The text it inserts"
        className="resize-none text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <span role="status" className="text-xs text-muted-foreground">
          {status}
        </span>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSave || saving}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * The create row's form, in the popover: name (prefilled from the query), text, then Save, which
 * saves the prompt, refreshes the cached list and hands the text back to insert. The server's
 * message, or the reason the draft can't be saved, shows in the form.
 */
export function SavedPromptForm({
  prompts,
  initialName,
  onSaved,
  onCancel,
}: {
  prompts: SavedPromptRow[];
  initialName: string;
  onSaved: (text: string) => void;
  onCancel: () => void;
}) {
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [text, setText] = useState("");
  const [serverError, setServerError] = useState<string>();
  const draftError = savedPromptDraftError(prompts, { name, text });
  const create = useMutation(
    orpc.savedPrompt.create.mutationOptions({
      onSuccess: async (_, input) => {
        await queryClient.invalidateQueries({ queryKey: orpc.savedPrompt.list.queryKey() });
        onSaved(input.text);
      },
      onError: (caught) => setServerError(caught.message),
    }),
  );

  return (
    <SavedPromptFormView
      name={name}
      onName={(next) => {
        setName(next);
        setServerError(undefined);
      }}
      text={text}
      onText={(next) => {
        setText(next);
        setServerError(undefined);
      }}
      status={serverError ?? draftError ?? "Saves, then inserts it."}
      canSave={!draftError}
      saving={create.isPending}
      onSubmit={(event) => {
        event.preventDefault();
        if (draftError || create.isPending) return;
        create.mutate({ name, text });
      }}
      onCancel={onCancel}
    />
  );
}
