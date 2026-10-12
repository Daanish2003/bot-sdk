import { reasoningChoiceLabel, type ReasoningChoice } from "../../core/shared/chat/models";
import type { MessageUsage } from "../../core/shared/chat/message-record";
import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Token usage"
        title="Token usage"
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
  return (
    <p>
      <span className="text-muted-foreground">Reasoning effort: </span>
      {reasoningChoiceLabel(reasoningEffort)}
    </p>
  );
}

/** The tokens a reply's Run used, and a note when they are an estimate. */
export function UsageBreakdown({ usage }: { usage: MessageUsage }) {
  const rows = [
    ["Input", usage.input],
    ["Output", usage.output],
    ["Reasoning", usage.reasoning],
    ["Cached", usage.cached],
  ] as const;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
        {rows.map(([label, tokens]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{tokens.toLocaleString("en-US")}</dd>
          </Fragment>
        ))}
      </dl>
      {usage.estimated && (
        <p className="text-muted-foreground">
          Estimate: the Provider reported no usage for this reply.
        </p>
      )}
    </div>
  );
}
