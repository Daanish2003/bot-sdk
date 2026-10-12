import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../procedures";
import { attachmentRouter } from "./attachment";
import { chatRouter } from "./chat";
import { connectionsRouter } from "./connections";
import { conversationRouter } from "./conversation";
import { credentialsRouter } from "./credentials";
import { modelsRouter } from "./models";
import { projectRouter } from "./project";
import { quotaRouter } from "./quota";
import { settingsRouter } from "./settings";
import { searchRouter } from "./search";
import { shareRouter } from "./share";

export const appRouter = {
  attachment: attachmentRouter,
  chat: chatRouter,
  connections: connectionsRouter,
  conversation: conversationRouter,
  credentials: credentialsRouter,
  models: modelsRouter,
  project: projectRouter,
  quota: quotaRouter,
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
export type AppRouterClient = RouterClient<typeof appRouter>;
