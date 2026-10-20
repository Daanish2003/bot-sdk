import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../../../../core/server/procedures";
import { artifactRouter } from "./artifact";
import { chatRouter } from "./chat";
import { connectionsRouter } from "./connections";
import { conversationRouter } from "./conversation";
import { knowledgeRouter } from "./knowledge";
import { projectRouter } from "./project";
import { savedPromptRouter } from "./saved-prompt";
import { settingsRouter } from "./settings";
import { searchRouter } from "./search";
import { shareRouter } from "./share";

export const appRouter = {
  artifact: artifactRouter,
  chat: chatRouter,
  connections: connectionsRouter,
  conversation: conversationRouter,
  knowledge: knowledgeRouter,
  project: projectRouter,
  savedPrompt: savedPromptRouter,
  settings: settingsRouter,
  search: searchRouter,
  share: shareRouter,
  healthCheck: publicProcedure.handler(() => {
    return "OK";
  }),
  privateData: protectedProcedure.handler(({ context }) => {
    return {
      message: "This is private",
      user: context.user,
    };
  }),
};
export type AppRouter = typeof appRouter;
/** The client of the assistant's routers. */
export type AssistantRouterClient = RouterClient<AppRouter>;
