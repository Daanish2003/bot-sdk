import type { ReleaseApproval } from "@botsdk/client/bot/release-approval";
import type { MessageKey } from "@botsdk/client/i18n";
import { UserRoundCheckIcon } from "lucide-react";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { ApprovalCard, SettledLine } from "./approval-card";

const settledKeys = {
  approved: "bots.releaseApprovalApproved",
  declined: "bots.releaseApprovalDeclined",
  dropped: "bots.releaseApprovalDropped",
} as const satisfies Record<NonNullable<ReleaseApproval["answer"]>, MessageKey>;

/**
 * A Bot's draft of a Representative, in the thread (ticket #1195): only a link to the
 * Representative's page, where the diff is and the owner answers. Once answered, dropped or past its
 * 7 days it is one line; the draft stays, and the page can still approve it.
 */
export function ReleaseApprovalCard({ card, text }: { card: ReleaseApproval; text: string }) {
  const { t } = useI18n();
  const { Link } = useChatAdapter();
  const page = { to: "representatives", id: card.representativeId } as const;
  const name = card.representativeName;
  const open = !card.answer && new Date(card.expiresAt) > new Date();

  if (!open) {
    return (
      <SettledLine
        data-release-approval={card.representativeId}
        data-state={card.answer ?? "expired"}
        icon={<UserRoundCheckIcon className="size-3" />}
      >
        {card.answer
          ? t(settledKeys[card.answer], { name })
          : t("bots.releaseApprovalExpired", { name })}{" "}
        <Link page={page} className="underline">
          {t("bots.releaseApprovalOpen")}
        </Link>
      </SettledLine>
    );
  }

  return (
    <ApprovalCard
      data-release-approval={card.representativeId}
      data-state="waiting"
      attention
      icon={<UserRoundCheckIcon className="size-4" />}
      title={t("bots.releaseApprovalTitle", { name })}
      actions={
        <Link page={page} className="text-sm font-medium underline">
          {t("bots.releaseApprovalReview")}
        </Link>
      }
    >
      <p className="whitespace-pre-wrap">{text}</p>
    </ApprovalCard>
  );
}
