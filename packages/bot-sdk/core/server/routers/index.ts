import { attachmentRouter } from "./attachment";

/** The core's own routers, served beside the plugins' under `<basePath>/rpc/<key>`. */
export const coreRouter = {
  attachment: attachmentRouter,
};
export type CoreRouter = typeof coreRouter;
