import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { auth } from "@/auth";
import { SharedConversation } from "@/components/chat-pages";
import { chat } from "@/lib/chat";

export const dynamic = "force-dynamic";

// One read per request: generateMetadata and the page share it.
const loadShared = cache((token: string) => chat.getSharedConversation(token));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const data = await loadShared(token);
  return { title: data?.title ?? "Shared link not found", robots: "noindex, nofollow" };
}

/** A Shared link's public, read-only page, outside the signed-in layout. */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await loadShared(token);
  if (!data) notFound();
  const session = await auth();
  return (
    <SharedConversation
      data={data}
      viewer={{ signedIn: Boolean(session), signInUrl: "/sign-in" }}
    />
  );
}
