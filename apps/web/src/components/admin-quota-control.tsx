import { Button } from "@ai-chat/ui/components/button";
import { Input } from "@ai-chat/ui/components/input";
import { Label } from "@ai-chat/ui/components/label";
import { useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { formatUsd } from "@/admin/users";
import type { AdminQuota } from "@/functions/admin-quota";
import { setUserQuota } from "@/functions/admin-quota";

type QuotaChange = {
  userId: string;
  mode: "default" | "unlimited" | "amount";
  budgetUsd?: number;
  reason: string | null;
};

/** The line that says what a user's Quota is now, for the Admin reading it. */
export function describeQuota(quota: AdminQuota): string {
  if (quota.mode === "unlimited") return "Unlimited, set by an Admin";
  if (quota.mode === "amount") {
    const budget = quota.budgetUsd ?? 0;
    if (budget === 0) return "$0.00: Host Models are off for this user";
    return `${formatUsd(Math.round(budget * 1_000_000))} per ${quota.window}, set by an Admin`;
  }
  if (quota.defaultBudgetUsd === null) return "Host default: unlimited";
  return `Host default: ${formatUsd(Math.round(quota.defaultBudgetUsd * 1_000_000))} per ${quota.window}`;
}

/**
 * The Quota control of the user detail page (spec #277): set an amount in dollars, make it
 * unlimited, or clear it back to the Host's default. The optional reason goes to the audit event.
 */
export function AdminQuotaControl({ userId, quota }: { userId: string; quota: AdminQuota }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("");

  const run = async (change: QuotaChange, done: string) => {
    setPending(true);
    try {
      await setUserQuota({ data: change });
      toast.success(done);
      await router.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The change did not save. Try again.");
    } finally {
      setPending(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const budget = String(new FormData(event.currentTarget).get("budgetUsd") ?? "");
    void run(
      { userId, mode: "amount", budgetUsd: Number(budget), reason: reason.trim() || null },
      "Quota saved",
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">{describeQuota(quota)}</p>
      <form onSubmit={submit} className="grid gap-3 sm:max-w-md">
        <div className="space-y-2">
          <Label htmlFor={`quota-budget-${userId}`}>
            Budget in dollars (0 turns Host Models off)
          </Label>
          <Input
            id={`quota-budget-${userId}`}
            name="budgetUsd"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`quota-reason-${userId}`}>
            Reason (optional, kept for the audit log)
          </Label>
          <Input
            id={`quota-reason-${userId}`}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            Set budget
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void run(
                { userId, mode: "unlimited", reason: reason.trim() || null },
                "Quota set to unlimited",
              )
            }
          >
            Make unlimited
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void run(
                { userId, mode: "default", reason: reason.trim() || null },
                "Quota cleared to the default",
              )
            }
          >
            Clear to default
          </Button>
        </div>
      </form>
    </div>
  );
}
