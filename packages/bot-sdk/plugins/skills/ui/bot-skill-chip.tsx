import { useI18n } from "../../../core/client/react/provider";
import type { BotSkillChange } from "../shared/changes";

/**
 * The "📘 Skill saved: <name>" or "Skill updated: <name>" chips under a Bot Message whose Turn
 * wrote a Skill (spec #713), one per Skill. Read-only here. Shows nothing when it wrote none.
 */
export function BotSkillChip({ changes }: { changes: BotSkillChange[] | null }) {
  const { t } = useI18n();
  if (!changes || changes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 self-start text-xs text-muted-foreground">
      {changes.map((change) => (
        <span key={change.name} className="rounded-full border px-2 py-0.5">
          {t(change.kind === "saved" ? "bots.skillSaved" : "bots.skillUpdated", {
            name: change.name,
          })}
        </span>
      ))}
    </div>
  );
}
