import { type WebPushChannel, webPushChannel } from "@botsdk/bot/channel";
import { webPushProvider } from "@botsdk/channel-web-push";

/**
 * The Host's web push Channel (spec #1024), over its VAPID key pair and contact, or none when any
 * of the three is unset: then the app offers no web push.
 */
export function webPushChannelsOf(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  BETTER_AUTH_URL: string;
}): WebPushChannel[] {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) return [];
  return [
    webPushChannel({
      provider: webPushProvider({
        publicKey: VAPID_PUBLIC_KEY,
        privateKey: VAPID_PRIVATE_KEY,
        subject: VAPID_SUBJECT,
      }),
      // A push opens the Bot's page in this app.
      appUrl: env.BETTER_AUTH_URL,
    }),
  ];
}
