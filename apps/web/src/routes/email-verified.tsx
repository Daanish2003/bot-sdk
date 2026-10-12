import { Button } from "@ai-chat/ui/components/button";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

// Where the verification link lands. A valid link has already signed the user in
// (autoSignInAfterVerification); an invalid or expired one comes back with ?error=.
export const Route = createFileRoute("/email-verified")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: EmailVerifiedPage,
});

function EmailVerifiedPage() {
  const { error } = Route.useSearch();
  const navigate = useNavigate();

  if (error) {
    return (
      <div className="mx-auto mt-10 w-full max-w-md space-y-6 p-6 text-center">
        <h1 className="text-3xl font-bold">This link did not verify your email</h1>
        <p className="text-muted-foreground">
          The link is invalid or has expired. Sign in and we will send you a new one.
        </p>
        <Link to="/login" className="underline">
          Sign in for a new link
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-10 w-full max-w-md space-y-6 p-6 text-center">
      <h1 className="text-3xl font-bold">Your email is verified</h1>
      <p className="text-muted-foreground">Thanks. Your account is ready.</p>
      <Button onClick={() => navigate({ to: "/c" })}>Continue to chat</Button>
    </div>
  );
}
