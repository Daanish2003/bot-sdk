import { cn } from "@/lib/utils";
import { type Reactions, reactionEmojis } from "@botsdk/client/bot/reaction";

import { useI18n } from "@botsdk/react/provider";

/**
 * The emojis on a Message (spec #761), as small chips under its bubble: the user's and the Bot's,
 * at most one each. Nothing renders when it has none.
 */
export function ReactionChips({ reactions, own }: { reactions?: Reactions; own: "user" | "bot" }) {
  const { t } = useI18n();
  const chips = (["user", "bot"] as const).flatMap((side) =>
    reactions?.[side] ? [{ side, emoji: reactions[side].emoji }] : [],
  );
  if (chips.length === 0) return null;
  return (
    <div
      data-reactions
      role="group"
      className={cn("flex gap-1", own === "user" ? "self-end" : "self-start")}
      aria-label={t("bots.reactions")}
    >
      {chips.map(({ side, emoji }) => (
        <span
          key={side}
          data-reaction={side}
          className="rounded-full border bg-background px-1.5 text-xs"
        >
          {emoji}
        </span>
      ))}
    </div>
  );
}

/**
 * The hover bar on a Bot's Message (spec #761): one button per emoji, shown on hover or focus.
 * Tapping the one already on the Message takes it off.
 */
export function ReactionBar({
  current,
  onReact,
  acting,
}: {
  current?: string;
  onReact: (emoji: string | null) => void;
  acting: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      data-reaction-bar
      role="toolbar"
      aria-label={t("bots.reactToMessage")}
      className="absolute -top-3 left-2 flex gap-0.5 rounded-full border bg-background px-1 opacity-0 shadow-sm group-focus-within:opacity-100 group-hover:opacity-100"
    >
      {reactionEmojis.map((emoji) => (
        <button
          key={emoji}
          type="button"
          data-emoji={emoji}
          aria-pressed={current === emoji}
          aria-label={t("bots.reactWith", { emoji })}
          disabled={acting}
          className={cn("rounded px-0.5 text-sm", current === emoji && "bg-muted")}
          onClick={() => onReact(current === emoji ? null : emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
