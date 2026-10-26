import { createFileRoute, redirect } from "@tanstack/react-router";

import { BotsShell } from "@/components/bots-shell";
import { getComputerFeaturesOn } from "@/functions/computer-features";
import { getUser } from "@/functions/get-user";

/** The Bots app: signed in, with the same session guard and shell as `_auth`. */
export const Route = createFileRoute("/bots")({
  component: BotsShell,
  beforeLoad: async () => {
    const session = await getUser();
    if (!session) {
      throw redirect({
        to: "/login",
      });
    }
    return { session };
  },
  loader: async ({ context }) => {
    if (!context.session) {
      throw redirect({
        to: "/login",
      });
    }
    // Whether the Bot page shows Memory, Skills and Knowledge: they are features only with a Computer.
    return { computerFeaturesOn: await getComputerFeaturesOn() };
  },
  // The Host's features are fixed while it runs, so the flag is fetched once.
  staleTime: Number.POSITIVE_INFINITY,
});
