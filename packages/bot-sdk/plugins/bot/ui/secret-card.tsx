import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { KeyRoundIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { useI18n } from "../../../core/client/react/provider";
import type { SecretRequest } from "../shared/secret";
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
  const titleId = useId();
  const [value, setValue] = useState("");
  const run = useRefusalToast();

  if (saved) {
    return (
      <div
        data-secret={request.name}
        data-state="saved"
        className="flex items-center gap-2 self-center text-xs text-muted-foreground"
      >
        <span className="h-px w-8 bg-border" />
        <span className="inline-flex items-center gap-1">
          <KeyRoundIcon className="size-3" />
          {t("bots.secretSaved", { name: request.name })}
        </span>
        <span className="h-px w-8 bg-border" />
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!value) return;
    const sent = value;
    setValue("");
    run(onSave(request.name, sent));
  };
  return (
    <Card
      role="group"
      aria-labelledby={titleId}
      data-secret={request.name}
      data-state="asking"
      size="sm"
      className="max-w-md self-start"
    >
      <form onSubmit={submit} className="contents">
        <CardHeader>
          <CardTitle id={titleId}>
            {t("bots.secretAsks", { bot: botName, name: request.name })}
          </CardTitle>
          <CardDescription>{request.why}</CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            type="password"
            autoComplete="off"
            aria-label={t("bots.secretValue")}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </CardContent>
        <CardFooter className="flex-col items-start gap-2">
          <Button type="submit" size="sm" disabled={saving || !value}>
            {t("bots.secretSave")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("bots.secretNeverValue", { bot: botName })}
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
