import { findImageModel } from "../../core/shared/chat/image-models";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { serverErrorText } from "../../core/client/rpc-error";
import { useI18n, useOrpc } from "../../core/client/react/provider";
import { groupImageModels } from "./image-model-groups";

/** The Image Model select: which Model makes Generated images, or the Host's default when none is picked. */
export function ImageModelSelect() {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const settings = useQuery(orpc.settings.get.queryOptions());
  const models = useQuery(orpc.models.list.queryOptions());
  const settingsKey = orpc.settings.get.queryKey();
  const setImageModel = useMutation(
    orpc.settings.setImageModel.mutationOptions({
      onMutate: ({ imageModel }) => {
        const previous = settings.data;
        queryClient.setQueryData(settingsKey, {
          backgroundModel: settings.data?.backgroundModel ?? null,
          imageModel,
          instructions: settings.data?.instructions ?? null,
        });
        return { previous };
      },
      onError: (error, _, context) => {
        if (context?.previous) queryClient.setQueryData(settingsKey, context.previous);
        toast.error(serverErrorText(i18n, error));
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
    }),
  );

  const available = models.data?.imageModels ?? [];
  const saved = settings.data?.imageModel ?? null;
  // A saved Image Model whose Provider lost its credentials stays selectable, and says so.
  const missingKey = saved !== null && !available.some((model) => model.id === saved);
  // `null` is the Host's default Image Model when it has one, else no images at all.
  const hostDefault = models.data?.defaultImageModel ?? null;
  const hostDefaultLabel = hostDefault ? (findImageModel(hostDefault)?.label ?? hostDefault) : null;
  const first: Array<{ value: string | null; label: string }> = [
    {
      value: null,
      label: hostDefaultLabel
        ? t("settings.hostDefaultModel", { model: hostDefaultLabel })
        : t("settings.noImages"),
    },
    ...(saved && missingKey
      ? [{ value: saved, label: t("settings.noKeyModel", { model: saved }) }]
      : []),
  ];
  const groups = groupImageModels(available);
  const items = [...first, ...available.map((model) => ({ value: model.id, label: model.label }))];

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("settings.images")}</h2>
      <div className="space-y-2 rounded-xl border px-4 py-3">
        <Label htmlFor="image-model">{t("settings.imageModel")}</Label>
        <Select
          items={items}
          value={saved}
          onValueChange={(imageModel) => setImageModel.mutate({ imageModel })}
          disabled={settings.isPending || models.isPending}
        >
          <SelectTrigger id="image-model" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {first.map((item) => (
                <SelectItem key={item.value ?? ""} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
            {groups.map((group) => (
              <SelectGroup key={group.provider}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                    {model.onHostCredentials ? ` ${t("settings.onHost")}` : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {missingKey ? t("settings.imageModelMissingKey") : t("settings.imageModelHelp")}
        </p>
      </div>
    </section>
  );
}
