import { instructionsMaxChars } from "../../core/shared/chat/instructions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "../../core/client/react/provider";

/**
 * The Instructions field: one free-text note sent with every Run from the next one. Saving over
 * the limit is refused by the server, and its message is shown here.
 */
export function InstructionsField() {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const { t, locale } = useI18n();
  const settings = useQuery(orpc.settings.get.queryOptions());
  const settingsKey = orpc.settings.get.queryKey();
  // `null` until the user types, so the field shows what is saved.
  const [draft, setDraft] = useState<string | null>(null);
  const saved = settings.data?.instructions ?? "";
  const value = draft ?? saved;
  const dirty = value !== saved;
  const save = useMutation(
    orpc.settings.setInstructions.mutationOptions({
      onSuccess: async () => {
        setDraft(null);
        toast.success(t("settings.instructionsSaved"));
        await queryClient.invalidateQueries({ queryKey: settingsKey });
      },
    }),
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("settings.instructions")}</h2>
      <form
        className="space-y-3 rounded-xl border px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          // Blank means none: the server stores it as null.
          save.mutate({ instructions: value.trim() === "" ? null : value });
        }}
      >
        <Label htmlFor="instructions">{t("settings.yourInstructions")}</Label>
        <Textarea
          id="instructions"
          value={value}
          disabled={settings.isPending}
          placeholder={t("settings.instructionsPlaceholder")}
          onChange={(event) => setDraft(event.target.value)}
          aria-invalid={value.length > instructionsMaxChars || undefined}
        />
        <div className="flex items-center justify-between gap-3">
          <p
            className={cn(
              "text-xs text-muted-foreground tabular-nums",
              value.length > instructionsMaxChars && "text-destructive",
            )}
          >
            {t("settings.characterCount", {
              count: value.length.toLocaleString(locale),
              max: instructionsMaxChars.toLocaleString(locale),
            })}
          </p>
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            {save.isPending ? t("settings.saving") : t("settings.save")}
          </Button>
        </div>
        {save.error ? (
          <p role="alert" className="text-xs text-destructive">
            {save.error.message}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("settings.instructionsHelp")}</p>
        )}
      </form>
    </section>
  );
}
