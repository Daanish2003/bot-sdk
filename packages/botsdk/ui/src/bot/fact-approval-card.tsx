import type { FactApproval } from "@botsdk/client/bot/fact-approval";
import type { MessageKey } from "@botsdk/client/i18n";
import { ListChecksIcon } from "lucide-react";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { ApprovalCard, SettledLine } from "./approval-card";

const settledKeys = {
  approved: "bots.factApprovalApproved",
  declined: "bots.factApprovalDeclined",
  dropped: "bots.factApprovalDropped",
} as const satisfies Record<NonNullable<FactApproval["answer"]>, MessageKey>;

/**
 * A Bot's proposed Published fact, in the thread (ticket #1264): only a link to the Facts page, where
 * both values are and the owner answers. Once answered, dropped or past its 7 days it is one line.
 */
export function FactApprovalCard({ card, text }: { card: FactApproval; text: string }) {
  const { t } = useI18n();
  const { Link } = useChatAdapter();
  const page = { to: "facts" } as const;
  const { key } = card;
  const open = !card.answer && new Date(card.expiresAt) > new Date();

  if (!open) {
    return (
      <SettledLine
        data-fact-approval={key}
        data-state={card.answer ?? "expired"}
        icon={<ListChecksIcon className="size-3" />}
      >
        {card.answer
          ? t(settledKeys[card.answer], { key })
          : t("bots.factApprovalExpired", { key })}{" "}
        <Link page={page} className="underline">
          {t("bots.factApprovalOpen")}
        </Link>
      </SettledLine>
    );
  }

  return (
    <ApprovalCard
      data-fact-approval={key}
      data-state="waiting"
      attention
      icon={<ListChecksIcon className="size-4" />}
      title={t("bots.factApprovalTitle", { key })}
      actions={
        <Link page={page} className="text-sm font-medium underline">
          {t("bots.factApprovalReview")}
        </Link>
      }
    >
      <p className="whitespace-pre-wrap">{text}</p>
    </ApprovalCard>
  );
}
