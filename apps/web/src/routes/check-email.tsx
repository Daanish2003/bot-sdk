import { Button } from "@ai-chat/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/check-email")({
  validateSearch: (search: Record<string, unknown>) => ({
    email: typeof search.email === "string" ? search.email : "",
    // Signing in before verifying sends a fresh link, and the screen says so.
    sent: search.sent === true || search.sent === "true",
  }),
  component: CheckEmailPage,
});

function CheckEmailPage() {
  const { email, sent } = Route.useSearch();
  const [resent, setResent] = useState(false);
  const [pending, setPending] = useState(false);

  async function resend() {
    setPending(true);
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: `${window.location.origin}/email-verified`,
    });
    setPending(false);
    if (error) {
      toast.error(error.message || "Could not send a new link. Try again.");
      return;
    }
    setResent(true);
  }

  const address = email ? <strong>{email}</strong> : "your address";
  let message = <>We sent a verification link to {address}. Open it to finish signing up.</>;
  if (resent) {
    message = <>We sent a new link to {address}. Open the newest one.</>;
  } else if (sent) {
    message = <>We sent you a new link to {address}. Open it to verify your email.</>;
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-md space-y-6 p-6 text-center">
      <h1 className="text-3xl font-bold">Check your email</h1>
      <p className="text-muted-foreground">{message}</p>
      <p className="text-muted-foreground text-sm">
        You need to verify your email before you can sign in.
      </p>
      <Button variant="outline" onClick={resend} disabled={pending || !email}>
        {pending ? "Sending..." : "Resend email"}
      </Button>
    </div>
  );
}
