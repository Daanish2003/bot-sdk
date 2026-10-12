import { Button } from "@ai-chat/ui/components/button";
import { Input } from "@ai-chat/ui/components/input";
import { Label } from "@ai-chat/ui/components/label";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/forgot-password")({
  // Set when a reset link was expired, already used or invalid, and it sent the visitor here.
  validateSearch: (search: Record<string, unknown>): { expired?: true } =>
    search.expired === true || search.expired === "true" ? { expired: true } : {},
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { expired } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function request(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    // The answer is the same whether or not the address has an account, so the page says the same.
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setPending(false);
    if (error) {
      toast.error(error.message || "Could not send a reset link. Try again.");
      return;
    }
    setSent(true);
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-md space-y-6 p-6">
      <h1 className="text-center text-3xl font-bold">Forgot password</h1>
      {sent ? (
        <p className="text-muted-foreground text-center">
          If an account exists for that address, we sent a reset link. The link works once and
          expires after an hour.
        </p>
      ) : (
        <>
          {expired ? (
            <p className="rounded-md border p-3 text-center text-sm">
              That reset link is invalid, has expired or was already used. Request a new one below.
            </p>
          ) : null}
          <form onSubmit={request} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Sending..." : "Send reset link"}
            </Button>
          </form>
        </>
      )}
      <p className="text-center">
        <Link to="/login" className="underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
