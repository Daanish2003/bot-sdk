import type { BotReview } from "@botsdk/client/bot/review";

import { useI18n } from "@botsdk/react/provider";
import { MessageCodeBlock } from "./message-code-block";

/** The call as a row shows it: a shell call's command, else its arguments as JSON. */
function commandOf(review: BotReview): { code: string; language: string } {
  const { command } = review.input;
  return typeof command === "string"
    ? { code: command, language: "sh" }
    : { code: JSON.stringify(review.input, null, 2), language: "json" };
}

/**
 * A Turn's tool activity as readable rows (spec #1117, #1126), for the Turn line's panel: one row
 * per auto-approved call, with what was done, then its command and output as formatted blocks (a
 * long one starts collapsed). The output was masked of Secrets before it was stored. `passes` are
 * the Turn's reviews that passed.
 */
export function BotActivity({ passes }: { passes: BotReview[] }) {
  const { t } = useI18n();
  return (
    <ul aria-label={t("bots.activity")} className="flex flex-col gap-3">
      {passes.map((review) => {
        const command = commandOf(review);
        return (
          <li key={review.id} data-review={review.id} className="flex min-w-0 flex-col gap-1">
            <span className="text-foreground">{review.summary}</span>
            <span>{review.reason}</span>
            <span className="sr-only">{t("bots.activityCommand")}</span>
            <MessageCodeBlock code={command.code} language={command.language} />
            {review.output && (
              <>
                <span className="sr-only">{t("bots.activityOutput")}</span>
                <MessageCodeBlock code={review.output} language="plaintext" />
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
