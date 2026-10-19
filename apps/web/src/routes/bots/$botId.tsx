import { BotConversation } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { createFileRoute } from "@tanstack/react-router";

import { HelpersPrototype } from "./-prototype-helpers";

export const Route = createFileRoute("/bots/$botId")({
  component: BotPage,
  // PROTOTYPE (#574): `?variant=A|B|C` swaps the Conversation for the Helpers UI prototype.
  validateSearch: (search: Record<string, unknown>): { variant?: string } =>
    typeof search.variant === "string" ? { variant: search.variant } : {},
});

function BotPage() {
  const { botId } = Route.useParams();
  const { variant } = Route.useSearch();
  if (variant && !import.meta.env.PROD) return <HelpersPrototype variant={variant} />;
  return <BotConversation botId={botId} />;
}
