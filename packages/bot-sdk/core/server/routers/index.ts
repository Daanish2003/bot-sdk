import type { RouterClient } from "@orpc/server";

import type { ModelsRouter } from "../../../plugins/models/server/routers/index";

import { protectedProcedure, publicProcedure } from "../procedures";
import { artifactRouter } from "./artifact";
import { attachmentRouter } from "./attachment";
import { chatRouter } from "./chat";
import { connectionsRouter } from "./connections";
import { conversationRouter } from "./conversation";
import { knowledgeRouter } from "./knowledge";
import { memoryRouter } from "./memory";
import { projectRouter } from "./project";
import { savedPromptRouter } from "./saved-prompt";
import { settingsRouter } from "./settings";
import { searchRouter } from "./search";
import { shareRouter } from "./share";

export const appRouter = {
  artifact: artifactRouter,
  attachment: attachmentRouter,
  chat: chatRouter,
  connections: connectionsRouter,
  conversation: conversationRouter,
  knowledge: knowledgeRouter,
  memory: memoryRouter,
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
/** The client of every enabled plugin's routers: the assistant's and the `models` plugin's. */
export type AppRouterClient = RouterClient<typeof appRouter & ModelsRouter>;
