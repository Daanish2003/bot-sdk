import type { HostFixture } from "../../../packages/chat-sdk/test/e2e/host";

import { fakeOllamaHost } from "./env";
import { seedUser } from "./seed-user";

/** apps/web as a Host of the shared end-to-end scenarios (`shared.spec.ts`). */
export const appWebHost: HostFixture = {
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
