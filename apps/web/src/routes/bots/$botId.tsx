import { BotConversation } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { BotMemoryChip, BotMemoryLive, BotMemoryPopover } from "@ai-chat/bot-sdk/plugins/memory/ui";
import { createFileRoute } from "@tanstack/react-router";

import { SafetyPrototype } from "./-prototype-safety";

export const Route = createFileRoute("/bots/$botId")({
  component: BotPage,
  // PROTOTYPE (#689): `?variant=A|B|C` swaps the Conversation for the Approval and Secrets UI prototype.
  validateSearch: (search: Record<string, unknown>): { variant?: string } =>
    typeof search.variant === "string" ? { variant: search.variant } : {},
});

function BotPage() {
  const { botId } = Route.useParams();
  const { variant } = Route.useSearch();
  if (variant && !import.meta.env.PROD) return <SafetyPrototype variant={variant} />;
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
