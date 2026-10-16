import { KeySettingsPage } from "@ai-chat/bot-sdk/plugins/models/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_auth/settings/keys")({
  component: KeySettingsPage,
});
