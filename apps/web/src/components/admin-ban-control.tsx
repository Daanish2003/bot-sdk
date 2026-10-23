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
import { Input } from "@ai-chat/ui/components/input";
import { Label } from "@ai-chat/ui/components/label";
import { Textarea } from "@ai-chat/ui/components/textarea";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import type { AdminUser } from "@/admin/users";
import { banUser, unbanUser } from "@/functions/admin-ban";

/**
 * The Ban or unban control of one row of the Admin users table (spec #277). An Admin gets none:
 * the server refuses to ban one too. A Ban asks for a reason and may end on a date.
 */
export function AdminBanControl({ user }: { user: AdminUser }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  if (user.role === "admin") return <span className="text-muted-foreground">Admin</span>;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setPending(true);
    try {
      await action();
      toast.success(done);
      setOpen(false);
      await router.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The change did not save. Try again.");
    } finally {
      setPending(false);
    }
  };

  if (user.banned) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => void run(() => unbanUser({ data: { userId: user.id } }), "User unbanned")}
      >
        Unban
      </Button>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const endsOn = String(form.get("endsOn") ?? "");
    void run(
      () =>
        banUser({
          data: {
            userId: user.id,
            reason: String(form.get("reason") ?? ""),
            endsOn: endsOn === "" ? null : endsOn,
          },
        }),
      "User banned",
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Ban</DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Ban {user.email}</DialogTitle>
            <DialogDescription>
              They are signed out everywhere, can't sign in, their running Turns and Helpers stop,
              and no Routine, Check-in or Channel message of theirs starts a Turn until the Ban ends
              or is lifted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`ban-reason-${user.id}`}>
              Reason (required, kept for the audit log)
            </Label>
            <Textarea id={`ban-reason-${user.id}`} name="reason" required maxLength={500} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`ban-ends-${user.id}`}>Ends on (optional, leave empty for good)</Label>
            <Input id={`ban-ends-${user.id}`} name="endsOn" type="date" />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              Ban user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
