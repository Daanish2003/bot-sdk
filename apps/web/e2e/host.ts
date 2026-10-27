import type { HostFixture } from "./support/host";

import { fakeOllamaHost } from "./env";
import { seedUser } from "./seed-user";

/** apps/web as a Host of the shared end-to-end page helpers. */
export const appWebHost: HostFixture = {
  signIn: (page) => seedUser(page),
  fakeOllamaHost,
  paths: { keys: "/settings/keys" },
};
