import { BotConversation } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { BotMemoryChip, BotMemoryLive, BotMemoryPopover } from "@ai-chat/bot-sdk/plugins/memory/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/bots/$botId")({
  component: BotPage,
});

function BotPage() {
  const { botId } = Route.useParams();
  return (
    <BotConversation
      botId={botId}
      headerEnd={
        <>
          <BotMemoryLive botId={botId} />
          <BotMemoryPopover botId={botId} />
        </>
      }
      afterTurn={(turn) => <BotMemoryChip changes={turn.memoryChanges} />}
    />
  );
}
