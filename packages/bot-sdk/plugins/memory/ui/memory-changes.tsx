import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { TurnChange } from "../shared/changes";
import { useChatAdapter, useI18n } from "../../../core/client/react/provider";

/**
 * The "Memory updated · N changes" chip under a reply whose turn changed the user's Memories
 * (#290). It opens a popover listing each change, and a link to manage Memory. Shows nothing when
 * the turn changed no Memory.
 */
export function MemoryChip({ changes }: { changes: TurnChange[] }) {
  const { Link } = useChatAdapter();
  const { t } = useI18n();
  if (changes.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: "outline", size: "xs" }),
          "w-fit text-muted-foreground",
        )}
      >
        {t("chat.memoryUpdated", { count: changes.length })}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3">
        <ul className="flex flex-col gap-2 text-xs">
          {changes.map((change) => (
            <li key={change.kind === "forgot" ? `forgot:${change.text}` : change.memoryId}>
              {change.kind === "added" && t("chat.memoryAdded", { text: change.text })}
              {change.kind === "updated" && (
                <>
                  {t("chat.memoryUpdatedPrefix")}{" "}
                  <s className="text-muted-foreground">{change.from}</s> → {change.text}
                </>
              )}
              {change.kind === "forgot" && t("chat.memoryForgot", { text: change.text })}
            </li>
          ))}
        </ul>
        <Link
          page={{ to: "keys" }}
          className="mt-3 block text-xs font-medium underline underline-offset-2"
        >
          {t("chat.manageMemory")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
