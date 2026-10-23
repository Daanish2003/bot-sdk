import type { HostFixture } from "../../../packages/bot-sdk/test/e2e/host";

import { fakeOllamaHost } from "./env";
import { seedUser } from "./seed-user";

/** apps/web as a Host of the shared end-to-end page helpers. */
export const appWebHost: HostFixture = {
  signIn: (page) => seedUser(page),
  fakeOllamaHost,
  paths: { keys: "/settings/keys" },
};
