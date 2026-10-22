import { BotCacheChip, BotConversation } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { BotMemoryChip, BotMemoryLive, BotMemoryPopover } from "@ai-chat/bot-sdk/plugins/memory/ui";
import { BotSkillChip, BotSkillsPopover } from "@ai-chat/bot-sdk/plugins/skills/ui";
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
          <BotSkillsPopover botId={botId} />
        </>
      }
      afterTurn={(turn) => (
        <>
          <BotMemoryChip changes={turn.memoryChanges} />
          <BotSkillChip botId={botId} changes={turn.skillChanges} />
          <BotCacheChip steps={turn.steps} />
        </>
      )}
    />
  );
}
