import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlertIcon } from "lucide-react";

import { useBotReviews } from "@botsdk/react/bot/reviews";
import { useCustomRules } from "@botsdk/react/bot/rules";
import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { FactApprovalCard } from "./fact-approval-card";
import { ReleaseApprovalCard } from "./release-approval-card";
import { ReviewRequest } from "./review-request";
import { RuleCard } from "./rule-card";

/**
 * The Bot header's "Waiting N" button (spec #989, prototype variant A with variant B's full
 * cards), N counting the Bot's pending Approvals (ADR 0030) and the Custom Rules it proposed (ADR
 * 0031). The popover lists each as a full card with Approve and Deny, then links to the rules page; when none waits, it says so. The list is the
 * Bot's reviews, which the open page's change log keeps current.
 */
export function WaitingPopover({ botId }: { botId: string }) {
  const { t } = useI18n();
  const { Link, orpc } = useChatAdapter();
  const { reviews, acting, allow, deny } = useBotReviews(botId, false);
  const pending = reviews.filter((review) => review.state === "pending");
  const rules = useCustomRules();
  const proposed = rules.rules.filter(
    (rule) => rule.state === "proposed" && rule.proposedByBotId === botId,
  );
  // A release or fact Approval is only a card in the thread, so the thread's own read says which wait.
  const thread = useQuery(orpc.bots.get.queryOptions({ input: { botId } }));
  const drafted = (thread.data?.messages ?? []).flatMap((message) =>
    message.control?.kind === "release_approval" &&
    !message.control.answer &&
    new Date(message.control.expiresAt) > new Date()
      ? [{ id: message.id, card: message.control, text: message.text }]
      : [],
  );
  const factCards = (thread.data?.messages ?? []).flatMap((message) =>
    message.control?.kind === "fact_approval" &&
    !message.control.answer &&
    new Date(message.control.expiresAt) > new Date()
      ? [{ id: message.id, card: message.control, text: message.text }]
      : [],
  );
  const count = pending.length + proposed.length + drafted.length + factCards.length;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" className={count === 0 ? "max-md:hidden" : ""} />
        }
      >
        <ShieldAlertIcon /> {t("bots.waiting", { count })}
      </PopoverTrigger>
      <PopoverContent className="max-h-[70vh] w-96 overflow-y-auto">
        {count === 0 ? (
          <p className="text-sm text-muted-foreground">{t("bots.waitingNothing")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pending.map((review) => (
              <li key={review.id}>
                <ReviewRequest
                  review={review}
                  onAllow={allow}
                  onDeny={deny}
                  acting={acting.has(review.id)}
                  allowLabel={t("bots.waitingApprove")}
                />
              </li>
            ))}
            {proposed.map((rule) => (
              <li key={rule.id} className="flex flex-col">
                <RuleCard
                  rule={rule}
                  onApprove={rules.approve}
                  onDeny={rules.deny}
                  acting={rules.acting.has(rule.id)}
                />
              </li>
            ))}
            {drafted.map(({ id, card, text }) => (
              <li key={id} className="flex flex-col">
                <ReleaseApprovalCard card={card} text={text} />
              </li>
            ))}
            {factCards.map(({ id, card, text }) => (
              <li key={id} className="flex flex-col">
                <FactApprovalCard card={card} text={text} />
              </li>
            ))}
          </ul>
        )}
        <Link page={{ to: "rules" }} className="mt-2 block text-sm underline">
          {t("bots.waitingRules")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
