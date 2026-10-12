/**
 * The hosts `fetch_url` may reach past the SSRF guard, from `SSRF_ALLOW_HOSTS` (comma-separated
 * `host` or `host:port`). Test-only, like the capture mailbox: the end-to-end tests serve their
 * fake page on localhost. It needs a localhost `BETTER_AUTH_URL`, so a public deployment refuses
 * it at start-up.
 */
export function ssrfAllowHostsOf(env: {
  BETTER_AUTH_URL: string;
  SSRF_ALLOW_HOSTS?: string | undefined;
}): string[] {
  const hosts = (env.SSRF_ALLOW_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (hosts.length === 0) return [];
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(env.BETTER_AUTH_URL)) {
    throw new Error("SSRF_ALLOW_HOSTS needs a localhost BETTER_AUTH_URL");
  }
  return hosts;
}
