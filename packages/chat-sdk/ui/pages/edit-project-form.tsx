import { modelGroups, modelLabel } from "../../core/client/models";
import { instructionsMaxChars } from "../../core/shared/chat/instructions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "../../core/client/react/provider";

/** The select's value for "no default Model", which a Project stores as `null`. */
const noModel = "none";

/**
 * Edits a Project's name, Instructions and default Model. The default Model and the Instructions
 * are sent only when the user changes them, so a stored Model that is no longer available doesn't
 * block a rename.
 */
export function EditProjectForm({
  projectId,
  name,
  defaultModel,
  instructions,
  onDone,
}: {
  projectId: string;
  name: string;
  /** The stored default Model; null when it has none. */
  defaultModel: string | null;
  /** The stored Instructions; null when the Project has none. */
  instructions: string | null;
  onDone: () => void;
}) {
  const orpc = useOrpc();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const models = useQuery(orpc.models.list.queryOptions());
  const [draftName, setDraftName] = useState(name);
  const [draftModel, setDraftModel] = useState(defaultModel ?? noModel);
  const [draftInstructions, setDraftInstructions] = useState(instructions ?? "");
  const update = useMutation(
    orpc.project.update.mutationOptions({
      onSuccess: async () => {
        toast.success(t("pages.projectSaved"));
        await queryClient.invalidateQueries({ queryKey: orpc.project.key() });
        onDone();
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  const trimmed = draftName.trim();
  const tooLong = draftInstructions.length > instructionsMaxChars;
  const available = models.data?.models ?? [];
  // A stored Model that `models.list` no longer offers stays selectable, and says so.
  const unavailable =
    defaultModel && !available.some((model) => model.id === defaultModel) ? defaultModel : null;
  const groups = modelGroups(available, "");
  // What the trigger shows for the selected value.
  const items = [
    { value: noModel, label: t("pages.noDefaultModel") },
    ...(unavailable
      ? [
          {
            value: unavailable,
            label: t("pages.unavailableModel", { model: modelLabel(unavailable) }),
          },
        ]
      : []),
    ...groups.flatMap((group) =>
      group.models.map((model) => ({ value: model.id, label: model.label })),
    ),
  ];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || tooLong) return;
    const changedModel = draftModel !== (defaultModel ?? noModel);
    const changedInstructions = draftInstructions !== (instructions ?? "");
    update.mutate({
      id: projectId,
      name: trimmed,
      defaultModel: changedModel ? (draftModel === noModel ? null : draftModel) : undefined,
      // Blank means none: the server stores it as null.
      instructions: changedInstructions ? draftInstructions.trim() || null : undefined,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border px-4 py-3">
      <div className="space-y-1.5">
        <Label htmlFor="project-name">{t("pages.name")}</Label>
        <Input
          id="project-name"
          maxLength={100}
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="project-model">{t("pages.defaultModel")}</Label>
        <Select
          items={items}
          value={draftModel}
          onValueChange={(value) => value && setDraftModel(value)}
          disabled={models.isPending}
        >
          <SelectTrigger id="project-model" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={noModel}>{t("pages.noDefaultModel")}</SelectItem>
              {unavailable && (
                <SelectItem value={unavailable}>
                  {t("pages.unavailableModel", { model: modelLabel(unavailable) })}
                </SelectItem>
              )}
            </SelectGroup>
            {groups.map((group) => (
              <SelectGroup key={group.provider}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("pages.projectModelHelp")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="project-instructions">{t("pages.instructions")}</Label>
        <Textarea
          id="project-instructions"
          value={draftInstructions}
          placeholder={t("pages.projectInstructionsPlaceholder")}
          onChange={(event) => setDraftInstructions(event.target.value)}
          aria-invalid={tooLong || undefined}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t("pages.projectInstructionsHelp")}</p>
          <p
            className={cn(
              "shrink-0 text-xs tabular-nums text-muted-foreground",
              tooLong && "text-destructive",
            )}
          >
            {t("pages.characterCount", {
              count: draftInstructions.length.toLocaleString(locale),
              max: instructionsMaxChars.toLocaleString(locale),
            })}
          </p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" type="button" onClick={onDone}>
          {t("pages.cancel")}
        </Button>
        <Button size="sm" type="submit" disabled={!trimmed || tooLong || update.isPending}>
          {update.isPending ? t("pages.saving") : t("pages.save")}
        </Button>
      </div>
    </form>
  );
}
