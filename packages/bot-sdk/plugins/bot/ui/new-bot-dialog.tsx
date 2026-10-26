import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { useChatAdapter, useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import { ModelPicker } from "../../models/ui/shell/model-picker";

/**
 * "+ New Bot": a name and a Model (the user's Models, the Host's default selected). The new Bot
 * opens straight away, with an empty Conversation.
 */
export function NewBotDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { orpc, navigate } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  const queryClient = useQueryClient();
  const models = useQuery(orpc.models.list.queryOptions());
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string>();
  const model = picked ?? models.data?.defaultModel ?? undefined;

  // Closing the dialog, however it closes, starts the next one afresh.
  const close = () => {
    onOpenChange(false);
    setName("");
    setPicked(undefined);
  };

  const create = useMutation(
    orpc.bots.create.mutationOptions({
      onSuccess: async (created) => {
        // The new Bot has the newest activity, so it goes first.
        queryClient.setQueryData(orpc.bots.list.queryKey(), (bots) => [
          { ...created, turnStatus: null, lastMessage: null },
          ...(bots ?? []),
        ]);
        close();
        await navigate({ to: "bots", id: created.id });
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && model) create.mutate({ name: name.trim(), model });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("bots.newBot")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            autoFocus
            aria-label={t("bots.name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("bots.namePlaceholder")}
            maxLength={100}
          />
          <ModelPicker value={model} models={models.data?.models ?? []} onSelect={setPicked} />
          <Button type="submit" disabled={!name.trim() || !model || create.isPending}>
            {t("bots.create")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
