import { Button } from "@ai-chat/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ai-chat/ui/components/dialog";
import { Label } from "@ai-chat/ui/components/label";
import { Textarea } from "@ai-chat/ui/components/textarea";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import type { AdminUser } from "@/admin/users";
import { turnOffTwoFactor } from "@/functions/admin-two-factor";

/**
 * The control that turns off a user's lost two-factor sign-in (spec #277). Shown only when the user
 * has it on. Confirm the request by email reply first (see `scripts/turn-off-2fa.md`).
 */
export function AdminTwoFactorControl({ user }: { user: AdminUser }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    try {
      await turnOffTwoFactor({
        data: { userId: user.id, reason: String(form.get("reason") ?? "") },
      });
      toast.success("Two-factor sign-in turned off");
      setOpen(false);
      await router.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The change did not save. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Turn off 2FA</DialogTrigger>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Turn off two-factor sign-in for {user.email}</DialogTitle>
            <DialogDescription>
              Only after their request was confirmed by a reply from their email address (see the
              runbook in scripts/turn-off-2fa.md). Their sessions end, they sign in with their
              password alone, and they get an email.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`two-factor-reason-${user.id}`}>
              Reason (required, kept for the audit log)
            </Label>
            <Textarea id={`two-factor-reason-${user.id}`} name="reason" required maxLength={500} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              Turn off 2FA
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
