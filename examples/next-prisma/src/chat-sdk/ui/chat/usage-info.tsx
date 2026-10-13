import { reasoningChoiceLabel, type ReasoningChoice } from "../../core/shared/chat/models";
import type { MessageUsage } from "../../core/shared/chat/message-record";
import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "../../core/client/react/provider";
import { cn } from "@/lib/utils";
import { InfoIcon } from "lucide-react";
import { Fragment } from "react";

/**
 * An assistant Message's reasoning effort and tokens behind an info control. Tokens only, never
 * cost. `reasoningEffort` is the effort the reply ran with; `null` is the Model's default.
 */
export function UsageInfo({
  usage,
  reasoningEffort,
}: {
  usage: MessageUsage | null;
  reasoningEffort: ReasoningChoice | null;
}) {
  const { t } = useI18n();
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("chat.tokenUsage")}
        title={t("chat.tokenUsage")}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "text-muted-foreground",
        )}
      >
        <InfoIcon />
      </PopoverTrigger>
      <PopoverContent className="w-52 p-3">
        <div className="flex flex-col gap-3 text-xs">
          <EffortLine reasoningEffort={reasoningEffort} />
          {usage && <UsageBreakdown usage={usage} />}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The reasoning effort a reply ran with; `null` reads as the Model's default. */
export function EffortLine({ reasoningEffort }: { reasoningEffort: ReasoningChoice | null }) {
  const i18n = useI18n();
  return (
    <p>
      <span className="text-muted-foreground">{i18n.t("chat.reasoningEffort")}: </span>
      {reasoningChoiceLabel(i18n, reasoningEffort)}
    </p>
  );
}

/** The tokens a reply's Run used, and a note when they are an estimate. */
export function UsageBreakdown({ usage }: { usage: MessageUsage }) {
  const { t, locale } = useI18n();
  const rows = [
    [t("chat.usageInput"), usage.input],
    [t("chat.usageOutput"), usage.output],
    [t("chat.usageReasoning"), usage.reasoning],
    [t("chat.usageCached"), usage.cached],
  ] as const;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        {rows.map(([label, tokens]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{tokens.toLocaleString(locale)}</dd>
          </Fragment>
        ))}
      </dl>
      {usage.estimated && <p className="text-muted-foreground">{t("chat.usageEstimate")}</p>}
    </div>
  );
}
