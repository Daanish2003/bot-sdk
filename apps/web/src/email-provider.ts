import { mailpitEmailProvider } from "@ai-chat/bot-sdk/plugins/channel/mailpit";
import type { EmailProvider } from "@ai-chat/bot-sdk/plugins/channel/server";

/**
 * The Host's email provider for the Channel (spec #761). Mail comes in through Mailpit, which
 * checks that it holds the message the webhook names, or not at all: the route never takes a mail
 * from the request's own JSON, since anyone who reaches it could forge a DMARC pass in it. Without
 * `MAILPIT_API_URL`, every mail is refused and nothing is sent. (The fake provider is for tests and
 * evals.)
 */
export function emailProviderOf(
  env: { MAILPIT_API_URL?: string },
  fetcher?: typeof fetch,
): EmailProvider {
  if (env.MAILPIT_API_URL) {
    return mailpitEmailProvider({ apiUrl: env.MAILPIT_API_URL, fetch: fetcher });
  }
  return {
    parseInbound: async () => ({ rejected: "No mail service: set MAILPIT_API_URL" }),
    send: async () => {},
  };
}
