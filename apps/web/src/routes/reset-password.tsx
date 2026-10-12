import { Button } from "@ai-chat/ui/components/button";
import { Input } from "@ai-chat/ui/components/input";
import { Label } from "@ai-chat/ui/components/label";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

// Where a reset link lands. Better Auth checks the token before this page: an invalid, expired or
// used one comes back with ?error=INVALID_TOKEN, and a valid one with ?token=.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.error || !search.token)
      throw redirect({ to: "/forgot-password", search: { expired: true } });
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function reset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token: token ?? "" });
    setPending(false);
    if (error) {
      if (error.code === "INVALID_TOKEN") {
        // Used by an earlier submit, or expired since the page loaded.
        navigate({ to: "/forgot-password", search: { expired: true } });
        return;
      }
      toast.error(error.message || "Could not reset the password. Try again.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="mx-auto mt-10 w-full max-w-md space-y-6 p-6 text-center">
        <h1 className="text-3xl font-bold">Password changed</h1>
        <p className="text-muted-foreground">
          Your other sessions are signed out. Sign in with your new password.
        </p>
        <Link to="/login" className="underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-md space-y-6 p-6">
      <h1 className="text-center text-3xl font-bold">Choose a new password</h1>
      <form onSubmit={reset} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Saving..." : "Set new password"}
        </Button>
      </form>
    </div>
  );
}
