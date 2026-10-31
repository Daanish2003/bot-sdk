import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RoomMember } from "@botsdk/client/bot/contract";
import { SendIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useId, useRef, useState } from "react";

import { useI18n } from "@botsdk/react/provider";

/**
 * The mention being typed at `caret`: the `@` it starts at and what follows it. None for an `@`
 * inside a word (an email address), or once a line break or another `@` follows it.
 */
function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const start = text.lastIndexOf("@", caret - 1);
  if (start === -1) return undefined;
  if (start > 0 && /[\p{L}\p{N}_]/u.test(text[start - 1]!)) return undefined;
  const query = text.slice(start + 1, caret);
  if (/[\n@]/.test(query)) return undefined;
  return { start, query };
}

/**
 * A Room's composer (spec #1055). Typing `@` offers the members whose name starts with what follows
 * it, case-insensitive: the arrow keys move through them, Enter or Tab or a click picks one, which
 * puts its full name in, and Escape closes the list. Enter sends otherwise, unless `disabled`.
 */
export function RoomComposer({
  members,
  draft,
  setDraft,
  onSend,
  onStop,
  disabled = false,
}: {
  members: RoomMember[];
  draft: string;
  setDraft: (draft: string) => void;
  onSend: () => void;
  /** Ends every Turn running in the Room; the Stop button shows while one is given. */
  onStop?: () => void;
  /** No sending, as in a Room left with one Bot. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // The `@` whose list Escape or a pick closed: it stays closed until that `@` is gone.
  const [closedAt, setClosedAt] = useState<number>();
  // A sent (cleared) draft closes nothing.
  if (!draft && closedAt !== undefined) setClosedAt(undefined);

  const mention = mentionAt(draft, caret);
  const options =
    mention && mention.start !== closedAt
      ? members.filter((member) =>
          member.name.toLowerCase().startsWith(mention.query.toLowerCase()),
        )
      : [];
  const open = options.length > 0;
  const highlighted = Math.min(active, options.length - 1);

  const pick = (member: RoomMember) => {
    if (!mention) return;
    const before = draft.slice(0, mention.start);
    const after = draft.slice(caret);
    const inserted = `@${member.name} `;
    setDraft(before + inserted + after);
    const at = before.length + inserted.length;
    setCaret(at);
    setActive(0);
    // Done, even when a longer name starts with the picked one and a space.
    setClosedAt(mention.start);
    requestAnimationFrame(() => box.current?.setSelectionRange(at, at));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An IME's keys confirm what it composes.
    if (event.nativeEvent.isComposing) return;
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((highlighted + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(options[highlighted]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setClosedAt(mention?.start);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend();
  };

  return (
    <form onSubmit={submit} className="relative flex items-end gap-2 border-t p-3">
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("bots.mentionMember")}
          className="absolute bottom-full left-3 mb-1 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.map((member, index) => (
            <li
              key={member.botId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              className="cursor-pointer rounded-sm px-2 py-1.5 text-sm aria-selected:bg-accent"
              // Before the textarea loses focus.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(member);
              }}
            >
              {member.name}
            </li>
          ))}
        </ul>
      )}
      <Textarea
        ref={box}
        aria-label={t("bots.message")}
        placeholder={t("bots.message")}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${highlighted}` : undefined}
        value={draft}
        onChange={(event) => {
          const { value } = event.target;
          const at = event.target.selectionStart ?? value.length;
          setDraft(value);
          setCaret(at);
          setActive(0);
          // An `@` typed again where a closed one was is a new mention.
          if (mentionAt(value, at)?.start !== closedAt) setClosedAt(undefined);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        rows={1}
        className="max-h-40 min-h-10 resize-none"
      />
      {onStop && (
        <Button type="button" variant="outline" onClick={onStop}>
          ■ {t("bots.stop")}
        </Button>
      )}
      <Button
        type="submit"
        size="icon"
        aria-label={t("bots.send")}
        disabled={!draft.trim() || disabled}
      >
        <SendIcon />
      </Button>
    </form>
  );
}
