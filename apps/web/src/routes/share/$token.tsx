import { SharedConversationPage, SharedLinkNotFound } from "@ai-chat/chat-sdk/ui";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type { ComponentProps } from "react";

import { getSharedConversation } from "@/functions/get-shared-conversation";
import { getUser } from "@/functions/get-user";

const noindex = { name: "robots", content: "noindex, nofollow" };

type Snapshot = ComponentProps<typeof SharedConversationPage>["data"];

/** A Shared link's public, read-only page, outside the signed-in layout (ADR 0004). */
export const Route = createFileRoute("/share/$token")({
  loader: async ({ params }): Promise<{ shared: Snapshot; signedIn: boolean }> => {
    const [shared, user]: [Snapshot | null, unknown] = await Promise.all([
      getSharedConversation({ data: params.token }),
      getUser(),
    ]);
    if (!shared) throw notFound();
    return { shared, signedIn: Boolean(user) };
  },
  head: ({ loaderData }) => ({
    meta: [
      noindex,
      { title: loaderData ? `${loaderData.shared.title} · ai-chat` : "Not found · ai-chat" },
    ],
  }),
  component: SharedLinkPage,
  notFoundComponent: SharedLinkNotFound,
});

function SharedLinkPage() {
  const { shared, signedIn } = Route.useLoaderData();
  return <SharedConversationPage data={shared} viewer={{ signedIn, signInUrl: "/login" }} />;
}
