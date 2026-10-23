import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { suspendedMessage } from "@/admin/ban";
import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import SocialSignIn from "@/components/social-sign-in";
import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/login")({
  // Where a failed OAuth sign-in lands (`errorCallbackURL`), with Better Auth's error code. Optional,
  // so links to /login need no search.
  validateSearch: z.object({ error: z.string().optional().catch(undefined) }),
  beforeLoad: async () => {
    if (await getUser()) throw redirect({ to: "/bots" });
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { error } = Route.useSearch();
  const [showSignIn, setShowSignIn] = useState(false);

  return (
    <main className="flex-1 overflow-y-auto">
      {error === "BANNED_USER" && (
        <p role="alert" className="mx-auto mt-6 w-full max-w-md px-6 text-center text-red-500">
          {suspendedMessage}
        </p>
      )}
      {showSignIn ? (
        <SignInForm onSwitchToSignUp={() => setShowSignIn(false)} />
      ) : (
        <SignUpForm onSwitchToSignIn={() => setShowSignIn(true)} />
      )}
      <SocialSignIn />
    </main>
  );
}
