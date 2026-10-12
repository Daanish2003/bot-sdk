import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";

import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import SocialSignIn from "@/components/social-sign-in";
import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (await getUser()) throw redirect({ to: "/c" });
  },
  component: RouteComponent,
});

function RouteComponent() {
  const [showSignIn, setShowSignIn] = useState(false);

  return (
    <main className="flex-1 overflow-y-auto">
      {showSignIn ? (
        <SignInForm onSwitchToSignUp={() => setShowSignIn(false)} />
      ) : (
        <SignUpForm onSwitchToSignIn={() => setShowSignIn(true)} />
      )}
      <SocialSignIn />
    </main>
  );
}
