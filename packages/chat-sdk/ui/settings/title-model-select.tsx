import { missingCredentialsMessage, modelGroups, modelLabel } from "../../core/client/models";
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

import { useByok } from "../../core/client/react/byok";
import { useOrpc } from "../../core/client/react/provider";

/** The Title Model select: which Model writes automatic titles ("Same as first reply" by default). */
export function TitleModelSelect() {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const settings = useQuery(orpc.settings.get.queryOptions());
  const models = useQuery(orpc.models.list.queryOptions());
  const byok = useByok();
  const settingsKey = orpc.settings.get.queryKey();
  const setTitleModel = useMutation(
    orpc.settings.setTitleModel.mutationOptions({
      onMutate: ({ titleModel }) => {
        const previous = settings.data;
        queryClient.setQueryData(settingsKey, {
          titleModel,
          instructions: settings.data?.instructions ?? null,
        });
        return { previous };
      },
      onError: (error, _, context) => {
        if (context?.previous) queryClient.setQueryData(settingsKey, context.previous);
        toast.error(error.message);
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
    }),
  );

  const available = models.data?.models ?? [];
  const saved = settings.data?.titleModel ?? null;
  // A saved Title Model whose Provider lost its credentials stays selectable, and says so.
  const missingKey = saved ? missingCredentialsMessage(saved, available, byok) : null;
  const groups = modelGroups(available, "");
  // `null` is "Same as first reply".
  const first: Array<{ value: string | null; label: string }> = [
    { value: null, label: "Same as first reply" },
    ...(saved && missingKey ? [{ value: saved, label: `${modelLabel(saved)} (no key)` }] : []),
  ];
  // What the trigger shows for the selected value.
  const items = [
    ...first,
    ...groups.flatMap((group) =>
      group.models.map((model) => ({ value: model.id, label: model.label })),
    ),
  ];

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Titles</h2>
      <div className="space-y-2 rounded-xl border px-4 py-3">
        <Label htmlFor="title-model">Title Model</Label>
        <Select
          items={items}
          value={saved}
          onValueChange={(titleModel) => setTitleModel.mutate({ titleModel })}
          disabled={settings.isPending || models.isPending}
        >
          <SelectTrigger id="title-model" size="sm" className="w-full">
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
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {missingKey
            ? `${missingKey}. Until then, titles are the start of your first Message.`
            : "Writes each new Conversation's title after the first reply. A cheap Model is enough."}
        </p>
      </div>
    </section>
  );
}
