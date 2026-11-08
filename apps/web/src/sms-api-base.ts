const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/**
 * The SMS adapter's API base from `SMS_API_BASE` (spec #1174), the lab phone in place of Telnyx.
 * The lab phone accepts any API key and `SMS_API_BASE` sends it every account's Telnyx key, so it
 * is for a Host on this machine only: both it and `BETTER_AUTH_URL` must be localhost, or the app
 * refuses to start.
 */
export function smsApiBaseOf(env: {
  BETTER_AUTH_URL: string;
  SMS_API_BASE?: string | undefined;
}): string | undefined {
  if (!env.SMS_API_BASE) return undefined;
  if (!local.test(env.BETTER_AUTH_URL)) {
    throw new Error("SMS_API_BASE needs a localhost BETTER_AUTH_URL");
  }
  if (!local.test(env.SMS_API_BASE)) {
    throw new Error("SMS_API_BASE must be the lab phone on localhost");
  }
  return env.SMS_API_BASE;
}
