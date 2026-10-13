import { quotaMeterFrom } from "../../core/client/quota";
import { useI18n } from "../../core/client/react/provider";
import { useQuota } from "../../core/client/react/quota";
import { cn } from "@/lib/utils";

/** The composer's Quota meter, once the user has used `quotaMeterFrom`% of it. Percentages only. */
export function QuotaMeter() {
  const { t } = useI18n();
  const quota = useQuota().data;
  if (!quota || quota.usedPercent < quotaMeterFrom) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div
        role="meter"
        aria-label={t("chat.quotaUsed")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={quota.usedPercent}
        className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            quota.usedPercent >= 100 ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${quota.usedPercent}%` }}
        />
      </div>
      <span className="tabular-nums">
        {t("chat.quotaPercentUsed", { percent: quota.usedPercent })}
      </span>
    </div>
  );
}
