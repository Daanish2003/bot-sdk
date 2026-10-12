import { Button } from "@ai-chat/ui/components/button";
import { createFileRoute, Link } from "@tanstack/react-router";

import { authClient } from "@/lib/auth-client";

// Where both email-change links land. The confirmation link (sent to the current address) and the
// link to the new address both come back here; an invalid or expired one comes back with ?error=.
export const Route = createFileRoute("/email-changed")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: EmailChangedPage,
});

function EmailChangedPage() {
  const { error } = Route.useSearch();
  const { data: session } = authClient.useSession();

  if (error) {
    return (
      <div className="mx-auto mt-10 w-full max-w-md space-y-6 p-6 text-center">
        <h1 className="text-3xl font-bold">This link did not change your email</h1>
        <p className="text-muted-foreground">
          The link is invalid or has expired. Request the change again from your Account page.
        </p>
        <Link to="/settings/account" className="underline">
          Go to Account
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-md space-y-6 p-6 text-center">
      <h1 className="text-3xl font-bold">Email change</h1>
      <p className="text-muted-foreground">
        If you opened the link from your current address, open the link we sent to your new address
        to finish the change.
      </p>
      {session ? (
        <p className="text-sm">
          Your account email is <strong>{session.user.email}</strong>.
        </p>
      ) : null}
      <Button render={<Link to="/settings/account" />}>Back to Account</Button>
    </div>
  );
}
