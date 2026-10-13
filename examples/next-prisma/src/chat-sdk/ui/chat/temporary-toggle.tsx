import { cn } from "@/lib/utils";
import { EyeOffIcon } from "lucide-react";

/** The composer's Temporary toggle for a new Conversation; on means it starts temporary. */
export function TemporaryToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={(event) => {
        // The composer focuses its textarea on clicks.
        event.stopPropagation();
        onChange(!on);
      }}
      className={cn(
        "inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
      )}
    >
      <EyeOffIcon className="size-3.5" aria-hidden /> Temporary
    </button>
  );
}
