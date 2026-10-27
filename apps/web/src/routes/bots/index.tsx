import { BotsHomePage } from "@botsdk/ui/bot";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/bots/")({
  component: BotsHomePage,
});
