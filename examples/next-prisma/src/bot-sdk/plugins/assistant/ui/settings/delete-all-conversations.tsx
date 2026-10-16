import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "../../../../core/client/react/provider";
import { serverErrorText } from "../../../../core/client/rpc-error";

/** What the user types before the delete button turns on. Exact, so `delete` doesn't count. */
const confirmWord = "DELETE";

/**
 * Settings: deletes every Conversation the user has, Project ones included, after typing the
 * confirmation word. The Projects stay, empty, and so does the account.
 */
export function DeleteAllConversationsSection() {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const remove = useMutation(
    orpc.conversation.deleteAll.mutationOptions({
      onSuccess: async () => {
        setOpen(false);
        setTyped("");
        toast.success(t("settings.deleteAllDone"));
        // The Conversation panel, the Pinned section, and the Shared links the deleted ones held.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.conversation.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.share.key() }),
        ]);
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("settings.deleteAllTitle")}</h2>
      <p className="text-xs text-muted-foreground">{t("settings.deleteAllHelp")}</p>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setTyped("");
        }}
      >
        <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
          {t("settings.deleteAllTitle")}
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.deleteAllConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.deleteAllConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-all-confirm">
              {t("settings.typeToConfirmBefore")} <span className="font-mono">{confirmWord}</span>{" "}
              {t("settings.typeToConfirmAfter")}
            </Label>
            <Input
              id="delete-all-confirm"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={typed !== confirmWord || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? t("settings.deleting") : t("settings.deleteAll")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
