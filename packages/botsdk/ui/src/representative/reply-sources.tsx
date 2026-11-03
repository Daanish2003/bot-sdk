import { useI18n } from "@botsdk/react/provider";
import type { ReplyProof } from "@botsdk/representative/client";

/**
 * What a Representative's reply rests on (ticket #1262), beside the reply, for the owner only. Code
 * proved each source exists, not that the reply says it right, and the note says so.
 */
export function ReplySources({ reply }: { reply: ReplyProof }) {
  const { t } = useI18n();
  return (
    <span
      className="block space-y-0.5 text-xs text-muted-foreground"
      data-reply-kind={reply.kind ?? "none"}
    >
      <span className="block">
        {reply.kind
          ? t("representative.replyKind", { kind: reply.kind })
          : t("representative.replyKindUnknown")}
      </span>
      {reply.sources.length === 0 ? (
        <span className="block">{t("representative.replyNoSources")}</span>
      ) : (
        <ul className="list-inside list-disc">
          {reply.sources.map((source, at) => (
            <li key={at} className="break-words">
              {source.type === "fact"
                ? t("representative.replySourceFact", { key: source.key })
                : source.type === "document"
                  ? t("representative.replySourceDocument", {
                      name: source.name,
                      quote: source.quote,
                    })
                  : t("representative.replySourceAssignment", {
                      id: source.assignmentId,
                      quote: source.quote,
                    })}
            </li>
          ))}
        </ul>
      )}
      <span className="block">{t("representative.replySourcesNote")}</span>
    </span>
  );
}
