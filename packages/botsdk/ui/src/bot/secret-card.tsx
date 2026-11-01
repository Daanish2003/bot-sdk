import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SecretRequest } from "@botsdk/client/bot/secret";
import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useI18n } from "@botsdk/react/provider";
import { ApprovalCard, SettledLine } from "./approval-card";
import { useRefusalToast } from "./refusal-toast";

/**
 * A Bot's request for a Secret (spec #691), under the Message that asks: "<Bot> asks for NAME" with
 * why it is needed, a masked field, and "Save secret". The value goes through `onSave` (the
 * `secret.save` call), never the message path, and is cleared from the field once sent. Once the
 * Secret is `saved`, the card is the quiet "Saved secret NAME" divider.
 */
export function SecretCard({
  request,
  botName,
  saved,
  onSave,
  saving,
}: {
  request: SecretRequest;
  botName: string;
  saved: boolean;
  onSave: (name: string, value: string) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const run = useRefusalToast();

  if (saved) {
    return (
      <SettledLine
        data-secret={request.name}
        data-state="saved"
        icon={<KeyRoundIcon className="size-3" />}
      >
        {t("bots.secretSaved", { name: request.name })}
      </SettledLine>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!value) return;
    // The field keeps the value until the save is accepted, so a refusal costs no retyping.
    run(onSave(request.name, value).then(() => setValue("")));
  };
  return (
    <form onSubmit={submit} className="contents">
      <ApprovalCard
        data-secret={request.name}
        data-state="asking"
        title={t("bots.secretAsks", { bot: botName, name: request.name })}
        status={request.why}
        actions={
          <Button type="submit" size="sm" disabled={saving || !value}>
            {t("bots.secretSave")}
          </Button>
        }
      >
        <Input
          type="password"
          autoComplete="off"
          aria-label={t("bots.secretValue")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("bots.secretNeverValue", { bot: botName })}
        </p>
      </ApprovalCard>
    </form>
  );
}
