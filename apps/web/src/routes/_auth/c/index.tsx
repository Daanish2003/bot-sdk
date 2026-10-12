import { NewConversationPage } from "@ai-chat/chat-sdk/ui";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

export const Route = createFileRoute("/_auth/c/")({
  /**
   * `?model=` is the Model picked in the top bar; without it, `models.list`'s default. `?project=`
   * starts the Conversation inside that Project.
   */
  validateSearch: z.object({ model: z.string().optional(), project: z.string().optional() }),
  component: NewConversationPage,
});
