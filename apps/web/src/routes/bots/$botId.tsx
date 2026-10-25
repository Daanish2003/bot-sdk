import { BotCacheChip, BotConversation } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { EmailPopover } from "@ai-chat/bot-sdk/plugins/channel/ui";
import { KnowledgeChip, KnowledgePopover } from "@ai-chat/bot-sdk/plugins/knowledge/ui";
import { BotMemoryChip, BotMemoryPopover } from "@ai-chat/bot-sdk/plugins/memory/ui";
import { BotSkillChip, BotSkillsPopover } from "@ai-chat/bot-sdk/plugins/skills/ui";
import { createFileRoute } from "@tanstack/react-router";

import { getComputerFeaturesOn } from "@/functions/computer-features";

export const Route = createFileRoute("/bots/$botId")({
  component: BotPage,
  // Memory, Skills and Knowledge are features only with a Computer; without one, their controls are hidden.
  loader: () => getComputerFeaturesOn(),
});

function BotPage() {
  const { botId } = Route.useParams();
  const computerFeaturesOn = Route.useLoaderData();
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
