import { BotCacheChip, BotConversation, WaitingPopover } from "@botsdk/ui/bot";
import { ChannelsPopover, EmailPopover } from "@botsdk/ui/channel";
import { KnowledgeChip, KnowledgePopover } from "@botsdk/ui/knowledge";
import { BotMemoryChip, BotMemoryPopover } from "@botsdk/ui/memory";
import { BotSkillChip, BotSkillsPopover } from "@botsdk/ui/skills";
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
          <ChannelsPopover botId={botId} />
          <WaitingPopover botId={botId} />
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
