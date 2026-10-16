import { quotaResetsAt } from "../../client/quota";
import { useByok } from "../../client/react/byok";
import { useChatAdapter, useI18n } from "../../../../core/client/react/provider";
import { useQuotaSlot } from "../shell/quota-slot";

/**
 * Above the composer once the Quota is spent and the selected Model is a Host Model: when the
 * Host's Models come back, an "Add your own key" prompt when byok is on, and the Host's slot.
 */
export function QuotaBanner({ resetsAt }: { resetsAt: Date | string }) {
  const { Link } = useChatAdapter();
  const { t, locale } = useI18n();
  const byok = useByok();
  const slot = useQuotaSlot();
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <p>{t("chat.quotaSpent", { resetsAt: quotaResetsAt(resetsAt, locale) })}</p>
      {byok && (
        <Link page={{ to: "keys" }} className="w-fit underline">
          {t("chat.addYourOwnKey")}
        </Link>
      )}
      {slot}
    </div>
  );
}
