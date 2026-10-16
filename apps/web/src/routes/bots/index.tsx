import { BotsHomePage } from "@ai-chat/bot-sdk/plugins/bot/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/bots/")({
  component: BotsHomePage,
});
