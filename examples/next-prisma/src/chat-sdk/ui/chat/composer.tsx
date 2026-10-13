import { Button } from "@/components/ui/button";
import {
  PromptInput,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-kit/prompt-input";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

import { createName, rankSavedPrompts, slashQuery } from "../../core/client/saved-prompts-menu";
import { useOrpc } from "../../core/client/react/provider";
import { SavedPromptForm, SlashMenuList } from "./slash-menu";

/**
 * The docked composer: Enter sends, Shift+Enter starts a new line. While a reply streams, sending
 * is disabled and Send becomes Stop.
 */
export function Composer({
  onSend,
  onStop,
  streaming = false,
  disabled = false,
  children,
  attachments,
  attachmentsPending = false,
  placeholder = "Message (Shift+Enter for a new line)",
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  /** A reply is streaming in this Conversation. */
  streaming?: boolean;
  /** When sending isn't possible. */
  disabled?: boolean;
  /** Extra controls on the left of the actions row. */
  children?: ReactNode;
  /** The attachment chips, above the text. */
  attachments?: ReactNode;
  /** An attachment is still uploading (or failed), so sending waits. */
  attachmentsPending?: boolean;
  /** Shown instead of the default hint, for example while a call waits for Approval. */
  placeholder?: string;
}) {
  const orpc = useOrpc();
  const [value, setValue] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canSend = !disabled && !streaming && !attachmentsPending && value.trim().length > 0;

  // The `/` menu: open while the whole value is `/` plus a name, until Esc or the next edit.
  const query = slashQuery(value);
  const menuOpen = query !== undefined && !dismissed;
  // Fetched the first time the menu opens, then kept for the page.
  const savedPrompts = useQuery({
    ...orpc.savedPrompt.list.queryOptions(),
    enabled: menuOpen,
    staleTime: Infinity,
  });
  const prompts = savedPrompts.data?.items ?? [];
  const rowCount = rankSavedPrompts(prompts, query ?? "").length + 1;

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  };

  const insert = (text: string) => {
    setValue(text);
    setDismissed(true);
    wrapRef.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
  };

  const pick = (index: number) => {
    const matches = rankSavedPrompts(prompts, query ?? "");
    if (index >= matches.length) setCreating(true);
    else insert(matches[index]!.text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keys wait for the list: picking before it loads would create a prompt the user may already have.
    if (!menuOpen || creating || !savedPrompts.isSuccess) return;
    if (event.key === "ArrowDown") setActive((index) => (index + 1) % rowCount);
    else if (event.key === "ArrowUp") setActive((index) => (index - 1 + rowCount) % rowCount);
    else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") pick(active);
    else if (event.key === "Escape") setDismissed(true);
    else return;
    event.preventDefault();
  };

  return (
    <div ref={wrapRef} className="relative print:hidden">
      {menuOpen && (
        <div className="absolute bottom-full left-0 mb-2 w-full max-w-md overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
          {creating ? (
            <SavedPromptForm
              prompts={prompts}
              initialName={createName(query ?? "") ?? ""}
              onSaved={(text) => {
                setCreating(false);
                insert(text);
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <SlashMenuList
              prompts={prompts}
              query={query ?? ""}
              loaded={savedPrompts.isSuccess}
              active={active}
              onHover={setActive}
              onPick={pick}
            />
          )}
        </div>
      )}
      <PromptInput
        value={value}
        onValueChange={(next) => {
          setValue(next);
          setDismissed(false);
          setActive(0);
          if (slashQuery(next) === undefined) setCreating(false);
        }}
        // Enter while the menu is open picks a row (see onKeyDown), so it never sends.
        onSubmit={() => {
          if (!menuOpen) submit();
        }}
        isLoading={disabled || streaming}
        className="bg-card"
      >
        {attachments}
        <PromptInputTextarea
          placeholder={placeholder}
          className="text-sm text-foreground"
          aria-label="Message"
          onKeyDown={onKeyDown}
        />
        <PromptInputActions className="justify-between px-1 pt-1">
          <div className="flex items-center gap-1">{children}</div>
          <Button
            size="icon"
            className="rounded-full"
            disabled={streaming ? !onStop : !canSend}
            onClick={streaming ? onStop : submit}
            aria-label={streaming ? "Stop" : "Send"}
          >
            {streaming ? <SquareIcon className="fill-current" /> : <ArrowUpIcon />}
          </Button>
        </PromptInputActions>
      </PromptInput>
    </div>
  );
}
