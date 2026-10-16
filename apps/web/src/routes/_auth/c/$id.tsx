import { ChatView } from "@ai-chat/bot-sdk/ui";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/_auth/c/$id")({
  /** `?message=` is a search hit to scroll to and highlight (switching to its Branch first). */
  validateSearch: z.object({ message: z.string().optional() }),
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      orpc.conversation.get.queryOptions({ input: { id: params.id } }),
    ),
  component: ConversationPage,
});

function ConversationPage() {
  const { id } = Route.useParams();
  const { message } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data } = useSuspenseQuery(orpc.conversation.get.queryOptions({ input: { id } }));
  return (
    <ChatView
      key={id}
      conversation={data}
      focusMessageId={message}
      onFocused={() => void navigate({ search: {}, replace: true })}
    />
  );
}
