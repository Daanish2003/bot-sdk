import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ShieldAlertIcon } from "lucide-react";

import { useBotReviews } from "@botsdk/react/bot/reviews";
import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { ReviewRequest } from "./review-request";

/**
 * The Bot header's "Waiting N" button (spec #989, prototype variant A with variant B's full
 * cards), N counting the Bot's pending Approvals (ADR 0030). The popover lists each as a full card
 * with Approve and Deny, then links to the rules page; when none waits, it says so. The list is the
 * Bot's reviews, which the open page's change log keeps current.
 */
export function WaitingPopover({ botId }: { botId: string }) {
  const { t } = useI18n();
  const { Link } = useChatAdapter();
  const { reviews, acting, allow, deny } = useBotReviews(botId, false);
  const pending = reviews.filter((review) => review.state === "pending");
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <ShieldAlertIcon /> {t("bots.waiting", { count: pending.length })}
      </PopoverTrigger>
      <PopoverContent className="max-h-[70vh] w-96 overflow-y-auto">
        {pending.length === 0 ? (
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
          </ul>
        )}
        <Link page={{ to: "rules" }} className="mt-2 block text-sm underline">
          {t("bots.waitingRules")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
