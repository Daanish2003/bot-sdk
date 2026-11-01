import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChoiceControl, ChoiceInput } from "@botsdk/client/bot/choice";
import { CheckIcon, ListChecksIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useI18n } from "@botsdk/react/provider";
import { ApprovalCard, SettledLine } from "./approval-card";
import { useRefusalToast } from "./refusal-toast";

/**
 * A question a Bot asked with options (spec #761), under its Message: one button per option, and
 * when the Bot allows it an "Other" field for free text. Once answered, the card is the quiet line
 * "You answered: ...", whoever answered and on whichever app. A refused answer (already answered
 * elsewhere) says why in a toast, and the card shows the answered state once the Conversation is
 * read again.
 */
export function ChoiceCard({
  card,
  onAnswer,
  acting,
}: {
  card: ChoiceControl;
  onAnswer: (answer: ChoiceInput) => Promise<void>;
  acting: boolean;
}) {
  const { t } = useI18n();
  const [other, setOther] = useState("");
  const run = useRefusalToast();

  if (card.answer) {
    return (
      <SettledLine data-choice data-state="answered" icon={<CheckIcon className="size-3" />}>
        {t("bots.choiceAnswered", { answer: card.answer.text })}
      </SettledLine>
    );
  }

  const submitOther = (event: FormEvent) => {
    event.preventDefault();
    const text = other.trim();
    if (text && !acting) run(onAnswer({ other: text }));
  };
  return (
    <ApprovalCard
      data-choice
      data-state="asking"
      icon={<ListChecksIcon className="size-4 shrink-0" />}
      title={t("bots.choiceTitle")}
      bodyClassName="max-h-none"
    >
      <div className="flex flex-wrap gap-2">
        {card.options.map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant="outline"
            data-option={option}
            disabled={acting}
            onClick={() => run(onAnswer({ option }))}
          >
            {option}
          </Button>
        ))}
      </div>

      {card.other && (
        <form onSubmit={submitOther} className="flex gap-2">
          <Input
            aria-label={t("bots.choiceOther")}
            placeholder={t("bots.choiceOtherPlaceholder")}
            value={other}
            onChange={(event) => setOther(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={acting || !other.trim()}>
            {t("bots.choiceSend")}
          </Button>
        </form>
      )}
    </ApprovalCard>
  );
}
