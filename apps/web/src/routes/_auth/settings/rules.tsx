import { RulesPage } from "@botsdk/ui/settings/rules-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/settings/rules")({
  component: RulesPage,
});
