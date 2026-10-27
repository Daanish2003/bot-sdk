import { BotCacheChip, BotConversation } from "@botsdk/ui/bot";
import { EmailPopover } from "@botsdk/ui/channel";
import { KnowledgeChip, KnowledgePopover } from "@ai-chat/bot-sdk/plugins/knowledge/ui";
import { BotMemoryChip, BotMemoryPopover } from "@ai-chat/bot-sdk/plugins/memory/ui";
import { BotSkillChip, BotSkillsPopover } from "@ai-chat/bot-sdk/plugins/skills/ui";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

export const Route = createFileRoute("/bots/$botId")({
  component: BotPage,
});

const botsRoute = getRouteApi("/bots");

function BotPage() {
  const { botId } = Route.useParams();
  // Memory, Skills and Knowledge are features only with a Computer; without one, their controls are hidden.
  const { computerFeaturesOn } = botsRoute.useLoaderData();
  return (
    <BotConversation
      botId={botId}
      headerEnd={
        <>
          {computerFeaturesOn && (
            <>
              <BotMemoryPopover botId={botId} />
              <BotSkillsPopover botId={botId} />
              <KnowledgePopover />
            </>
          )}
          <EmailPopover botId={botId} />
        </>
      }
      afterTurn={(turn) => (
        <>
          {computerFeaturesOn && (
            <>
              <BotMemoryChip changes={turn.memoryChanges} />
              <BotSkillChip botId={botId} changes={turn.skillChanges} />
              <KnowledgeChip botId={botId} changes={turn.knowledgeChanges} />
            </>
          )}
          <BotCacheChip steps={turn.steps} />
        </>
      )}
    />
  );
}
