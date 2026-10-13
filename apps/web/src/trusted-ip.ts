/**
 * The headers Better Auth reads the client IP from, from `TRUSTED_IP_HEADERS` (comma-separated
 * header names, e.g. `cf-connecting-ip`). Unset, it is undefined and Better Auth reads
 * `x-forwarded-for`. Behind a proxy that sets the header, rate limits count each client apart.
 */
export function trustedIpHeadersOf(env: {
  TRUSTED_IP_HEADERS?: string | undefined;
}): string[] | undefined {
  const headers = (env.TRUSTED_IP_HEADERS ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  return headers.length > 0 ? headers : undefined;
}
