import { botColour, botInitials } from "../client/avatar";

/** A Bot's avatar: its initials on a colour from its name. */
export function BotAvatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      data-slot="bot-avatar"
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: botColour(name), fontSize: size * 0.4 }}
    >
      {botInitials(name)}
    </span>
  );
}
