import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { BotSecret } from "@botsdk/client/bot/secret";
import { KeyRoundIcon } from "lucide-react";

import { dateFormat } from "../../../core/client/intl";
import { useI18n } from "../../../core/client/react/provider";
import { useRefusalToast } from "./refusal-toast";

/**
 * The Bot header's "Secrets N" button (spec #691). It opens a popover listing the user's Secrets
 * with the date each was saved and Delete, under "Shared by all your Bots. Values are never shown."
 */
export function SecretsPopover({
  secrets,
  onDelete,
  acting,
}: {
  secrets: BotSecret[];
  onDelete: (name: string) => Promise<void>;
  acting: ReadonlySet<string>;
}) {
  const { t, locale } = useI18n();
  const run = useRefusalToast();
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <KeyRoundIcon /> {t("bots.secretsCount", { count: secrets.length })}
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <ul aria-label={t("bots.secrets")} className="flex flex-col gap-2 text-sm">
          {secrets.map((secret) => (
            <li key={secret.name} data-secret={secret.name} className="flex items-center gap-2">
              <span className="font-mono font-medium">{secret.name}</span>
              <span className="text-xs text-muted-foreground">
                {t("bots.secretSavedOn", {
                  date: dateFormat(locale, { dateStyle: "medium" }).format(secret.createdAt),
                })}
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto"
                aria-label={t("bots.deleteSecret", { name: secret.name })}
                disabled={acting.has(secret.name)}
                onClick={() => run(onDelete(secret.name))}
              >
                {t("bots.delete")}
              </Button>
            </li>
          ))}
        </ul>
        <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          {t("bots.secretsShared")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
