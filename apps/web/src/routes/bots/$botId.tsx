import { BotConversation } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { createFileRoute } from "@tanstack/react-router";

import { RoutinesPrototype } from "./-prototype-routines";

export const Route = createFileRoute("/bots/$botId")({
  component: BotPage,
  // PROTOTYPE (#542): `?variant=A|B|C` swaps the Conversation for the Routines UI prototype.
  validateSearch: (search: Record<string, unknown>): { variant?: string } =>
    typeof search.variant === "string" ? { variant: search.variant } : {},
});

function BotPage() {
  const { botId } = Route.useParams();
  const { variant } = Route.useSearch();
  if (variant && !import.meta.env.PROD) return <RoutinesPrototype variant={variant} />;
  return <BotConversation botId={botId} />;
}
