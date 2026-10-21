import { useState } from "react";

import { useI18n } from "../../../core/client/react/provider";
import type { BotSkillChange } from "../shared/changes";
import { SkillEditor } from "./skill-editor";

/**
 * The "📘 Skill saved: <name>" or "📘 Skill updated: <name>" chips under a Bot Message whose Turn
 * wrote a Skill (spec #713), one per Skill. A chip expands in place to the same `SKILL.md` editor
 * as the Skills popover. Shows nothing when the Turn wrote no Skill.
 */
export function BotSkillChip({
  botId,
  changes,
}: {
  botId: string;
  changes: BotSkillChange[] | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (!changes || changes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 self-start text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-1">
        {changes.map((change) => (
          <button
            key={change.name}
            type="button"
            aria-expanded={open === change.name}
            className="rounded-full border px-2 py-0.5"
            onClick={() => setOpen(open === change.name ? null : change.name)}
          >
            {t(change.kind === "saved" ? "bots.skillSaved" : "bots.skillUpdated", {
              name: change.name,
            })}
          </button>
        ))}
      </div>
      {open && (
        <div className="w-[32rem] max-w-full rounded-lg border p-2 text-foreground">
          <SkillEditor botId={botId} name={open} onDeleted={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}
