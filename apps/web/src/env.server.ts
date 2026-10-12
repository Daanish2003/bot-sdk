import { ENV } from "./env";
import { ssrfAllowHostsOf } from "./ssrf-allow";

// The SSRF allowance is for the end-to-end tests too: refused unless BETTER_AUTH_URL is localhost.
export const ssrfAllowHosts = ssrfAllowHostsOf(ENV);

// The capture mailbox is for the end-to-end tests on this machine only: its messages hold live
// links, so it never runs against a public address.
if (
  ENV.EMAIL_TRANSPORT === "capture" &&
  !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(ENV.BETTER_AUTH_URL)
) {
  throw new Error("EMAIL_TRANSPORT=capture needs a localhost BETTER_AUTH_URL");
}

export { ENV };
