import { BotCacheChip, BotConversation } from "@botsdk/ui/bot";
import { EmailPopover } from "@botsdk/ui/channel";
import { KnowledgeChip, KnowledgePopover } from "@botsdk/ui/knowledge";
import { BotMemoryChip, BotMemoryPopover } from "@botsdk/ui/memory";
import { BotSkillChip, BotSkillsPopover } from "@botsdk/ui/skills";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import {
  type PrototypeVariant,
  useApprovalRulesPrototype,
} from "@/components/approval-rules-prototype";

export const Route = createFileRoute("/bots/$botId")({
  // PROTOTYPE (#988): ?variant= picks the Approval rules variant.
  validateSearch: (search: Record<string, unknown>): { variant?: PrototypeVariant } =>
    search.variant === "A" || search.variant === "B" || search.variant === "C"
      ? { variant: search.variant }
      : {},
  component: BotPage,
});

const botsRoute = getRouteApi("/bots");

function BotPage() {
  const { botId } = Route.useParams();
  const { variant = "A" } = Route.useSearch();
  const prototype = useApprovalRulesPrototype(variant);
  // Memory, Skills and Knowledge are features only with a Computer; without one, their controls are hidden.
  const { computerFeaturesOn } = botsRoute.useLoaderData();
  return (
    <>
      <BotConversation
        botId={botId}
        headerEnd={
          <>
            {prototype.header}
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
      {prototype.overlay}
    </>
  );
}
