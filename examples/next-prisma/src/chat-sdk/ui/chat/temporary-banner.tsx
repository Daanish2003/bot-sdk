import { EyeOffIcon } from "lucide-react";

/** Above a Temporary Conversation: it isn't kept in the history or Memory, and expires. */
export function TemporaryBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2 text-xs text-muted-foreground sm:px-6"
    >
      <EyeOffIcon className="size-3.5 shrink-0" aria-hidden />
      <span>
        Temporary chat: not saved to your history or Memory; deleted 30 days after the last message
      </span>
    </div>
  );
}
