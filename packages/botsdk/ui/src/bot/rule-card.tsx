import { Button } from "@/components/ui/button";
import type { CustomRule, CustomRuleMode } from "@botsdk/client/bot/rule";
import type { MessageKey } from "@botsdk/client/i18n";
import { ScrollTextIcon } from "lucide-react";

import { useI18n } from "@botsdk/react/provider";
import { ApprovalCard, SettledLine } from "./approval-card";
import { useRefusalToast } from "./refusal-toast";

export const modeKeys = {
  without_asking: "settings.ruleModeWithoutAsking",
  pre_approved: "settings.ruleModePreApproved",
  ask: "settings.ruleModeAsk",
  hand_off: "settings.ruleModeHandOff",
} as const satisfies Record<CustomRuleMode, MessageKey>;

/**
 * A Custom Rule a Bot proposed (spec #989), in the thread, the Waiting popover and the rules page:
 * while it is `proposed`, a card with the rule's text and mode and Approve / Deny; once active, a
 * one-line divider. A denied rule is gone, so there is nothing to draw.
 */
export function RuleCard({
  rule,
  onApprove,
  onDeny,
  acting,
}: {
  rule: CustomRule;
  onApprove: (ruleId: string) => Promise<void>;
  onDeny: (ruleId: string) => Promise<void>;
  acting: boolean;
}) {
  const { t } = useI18n();
  const run = useRefusalToast();

  if (rule.state !== "proposed") {
    return (
      <SettledLine
        data-rule-approval={rule.id}
        data-state={rule.state}
        icon={<ScrollTextIcon className="size-3" />}
      >
        {t("bots.ruleAdded", { text: rule.text })}
      </SettledLine>
    );
  }

  return (
    <ApprovalCard
      data-rule-approval={rule.id}
      data-state={rule.state}
      attention
      title={t("bots.ruleProposed")}
      status={t(modeKeys[rule.mode])}
      actions={
        <>
          <Button size="sm" disabled={acting} onClick={() => run(onApprove(rule.id))}>
            {t("bots.approve")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={acting}
            onClick={() => run(onDeny(rule.id))}
          >
            {t("bots.reviewDeny")}
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-wrap">{rule.text}</p>
    </ApprovalCard>
  );
}
