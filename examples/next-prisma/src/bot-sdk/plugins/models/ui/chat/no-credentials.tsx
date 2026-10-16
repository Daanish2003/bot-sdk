import { buttonVariants } from "@/components/ui/button";
import { KeyRoundIcon } from "lucide-react";

import { useByok } from "../../client/react/byok";
import { useChatAdapter, useI18n } from "../../../../core/client/react/provider";

/** The empty state for a user without any Provider credentials: nothing can be sent yet. */
export function NoCredentials() {
  const { Link } = useChatAdapter();
  const { t } = useI18n();
  const byok = useByok();
  if (!byok) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="max-w-sm">
          <h1 className="text-base font-medium">{t("shell.noModels")}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{t("chat.noModelsBody")}</p>
        </div>
      </main>
    );
  }
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
        <KeyRoundIcon className="size-5" />
      </div>
      <div className="max-w-sm">
        <h1 className="text-base font-medium">{t("chat.bringYourOwnKey")}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("chat.bringYourOwnKeyBody")}</p>
      </div>
      <Link page={{ to: "keys" }} className={buttonVariants()}>
        <KeyRoundIcon /> {t("chat.addProviderCredentials")}
      </Link>
      <p className="text-xs text-muted-foreground">{t("chat.keysEncrypted")}</p>
    </main>
  );
}
