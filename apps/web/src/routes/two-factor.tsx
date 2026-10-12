import { createFileRoute, redirect } from "@tanstack/react-router";

import { TwoFactorChallenge } from "@/components/two-factor-challenge";
import { getUser } from "@/functions/get-user";

export const Route = createFileRoute("/two-factor")({
  beforeLoad: async () => {
    if (await getUser()) throw redirect({ to: "/c" });
  },
  component: TwoFactorChallenge,
});
