import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { CustomRule } from "@botsdk/client/bot/rule";
import { ScrollTextIcon } from "lucide-react";
import { useId } from "react";

import { useI18n } from "@botsdk/react/provider";
import { modeKeys } from "../settings/rules-page";
import { useRefusalToast } from "./refusal-toast";

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
  const titleId = useId();
  const run = useRefusalToast();

  if (rule.state !== "proposed") {
    return (
      <div
        data-rule-approval={rule.id}
        data-state={rule.state}
        className="flex items-center gap-2 self-center text-xs text-muted-foreground"
      >
        <span className="h-px w-8 bg-border" />
        <span className="inline-flex items-center gap-1">
          <ScrollTextIcon className="size-3" />
          {t("bots.ruleAdded", { text: rule.text })}
        </span>
        <span className="h-px w-8 bg-border" />
      </div>
    );
  }

  return (
    <Card
      role="group"
      aria-labelledby={titleId}
      data-rule-approval={rule.id}
      data-state={rule.state}
      size="sm"
      className="max-w-md self-start"
    >
      <CardHeader>
        <CardTitle id={titleId}>{t("bots.ruleProposed")}</CardTitle>
        <CardDescription>{t(modeKeys[rule.mode])}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm whitespace-pre-wrap">{rule.text}</CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" disabled={acting} onClick={() => run(onApprove(rule.id))}>
          {t("bots.approve")}
        </Button>
        <Button size="sm" variant="outline" disabled={acting} onClick={() => run(onDeny(rule.id))}>
          {t("bots.reviewDeny")}
        </Button>
      </CardFooter>
    </Card>
  );
}
