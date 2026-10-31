import { RoomConversation } from "@botsdk/ui/bot";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/bots/rooms/$conversationId")({
  component: RoomPage,
});

function RoomPage() {
  const { conversationId } = Route.useParams();
  return <RoomConversation conversationId={conversationId} />;
}
