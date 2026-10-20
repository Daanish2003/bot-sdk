import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { auth } from "@/auth";
import { BotsFrame } from "@/components/bot-pages";

/** The Bots app: signed in, without the assistant's shell. */
export default async function BotsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session) redirect("/sign-in");
  return <BotsFrame>{children}</BotsFrame>;
}
