import type { HostFixture } from "../../../packages/chat-sdk/test/e2e/host";

import { fakeOllamaHost } from "./env";
import { seedUser } from "./seed-user";

/** The example Host (Next.js, Prisma, Auth.js) as a Host of the shared end-to-end scenarios. */
export const exampleHost: HostFixture = {
  signIn: (page) => seedUser(page),
  fakeOllamaHost,
  paths: {
    newConversation: "/c",
    conversation: /\/c\/[\w-]+$/,
    keys: "/settings/keys",
    sharedLink: /\/share\//,
    shared: (token) => `/share/${token}`,
    chatApi: "/api/chat",
  },
};
