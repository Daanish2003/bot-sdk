import { BrainIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "../../../core/client/react/provider";
import type { BotMemoryChange, MemoryTier } from "../shared/changes";

const tierKeys = {
  profile: "bots.memoryProfile",
  log: "bots.memoryLog",
  notes: "bots.memoryNotes",
} as const satisfies Record<MemoryTier, string>;

/**
 * The "Memory updated · N" chip under a Bot Message whose Turn's pass changed memory (#631,
 * prototype variant A). It expands to the lines remembered, changed (old struck through, then new)
 * and forgotten, each with its tier. There is no Undo. Shows nothing when the pass changed nothing.
 */
export function BotMemoryChip({ changes }: { changes: BotMemoryChange[] | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!changes || changes.length === 0) return null;
  return (
    <div className="self-start text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
        onClick={() => setOpen(!open)}
      >
        <BrainIcon className="size-3" />
        {t("bots.memoryUpdated", { count: changes.length })}
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5 rounded-lg border p-2">
          {changes.map((change, index) => {
            const tier = t(tierKeys[change.tier]);
            return (
              <li key={index}>
                {change.kind === "remembered" &&
                  t("bots.memoryRemembered", { text: change.text, tier })}
                {change.kind === "changed" && (
                  <>
                    {t("bots.memoryChangedPrefix")} <s>{change.from}</s> → {change.text} ({tier})
                  </>
                )}
                {change.kind === "forgot" && t("bots.memoryForgot", { text: change.text, tier })}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
