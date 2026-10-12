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

import { useOrpc } from "../../core/client/react/provider";

/** What the user types before the delete button turns on. Exact, so `delete` doesn't count. */
const confirmWord = "DELETE";

/**
 * Settings: deletes every Conversation the user has, Project ones included, after typing the
 * confirmation word. The Projects stay, empty, and so does the account.
 */
export function DeleteAllConversationsSection() {
  const queryClient = useQueryClient();
  const orpc = useOrpc();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const remove = useMutation(
    orpc.conversation.deleteAll.mutationOptions({
      onSuccess: async () => {
        setOpen(false);
        setTyped("");
        toast.success("All Conversations deleted");
        // The Conversation panel, the Pinned section, and the Shared links the deleted ones held.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.conversation.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.share.key() }),
        ]);
      },
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Delete all Conversations</h2>
      <p className="text-xs text-muted-foreground">
        Removes every Conversation, including those in your Projects, and their Shared links. Your
        Projects stay, empty. Your account stays too.
      </p>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setTyped("");
        }}
      >
        <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
          Delete all Conversations
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all Conversations?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes every Conversation for good, with its Messages and Shared links. Your
              Projects stay, but they are left empty. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-all-confirm">
              Type <span className="font-mono">{confirmWord}</span> to confirm
            </Label>
            <Input
              id="delete-all-confirm"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={typed !== confirmWord || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Deleting…" : "Delete all"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
