import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type FormEvent, useState } from "react";

import { useI18n } from "../../../core/client/react/provider";
import type { ChoiceInput } from "../shared/choice";
import type { ChoiceControl } from "../shared/choice";
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
      <p data-choice data-state="answered" className="self-start text-xs text-muted-foreground">
        {t("bots.choiceAnswered", { answer: card.answer.text })}
      </p>
    );
  }

  const submitOther = (event: FormEvent) => {
    event.preventDefault();
    const text = other.trim();
    if (text) run(onAnswer({ other: text }));
  };
  return (
    <div
      role="group"
      data-choice
      data-state="asking"
      className="flex max-w-[70%] flex-col gap-2 self-start"
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
    </div>
  );
}
