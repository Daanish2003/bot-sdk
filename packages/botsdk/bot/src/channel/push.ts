/** One device's push subscription, as the browser's `PushSubscription.toJSON()` gives it. */
export type PushSubscriptionKeys = {
  endpoint: string;
  /** The device's P-256 public key and auth secret, base64url. */
  keys: { p256dh: string; auth: string };
};

/** What one push carries, as JSON: the service worker shows it and opens `url` on a click. */
export type PushNotification = {
  /** The Bot's name. */
  title: string;
  /** The first line of the Message's text. */
  body: string;
  /** The Conversation's page in the Host app. */
  url: string;
  /** The Message's id: a resent push replaces the notification instead of adding one. */
  tag: string;
};

/**
 * The seam between the web push Channel and a push library (spec #1024): it encrypts and sends one
 * push to one subscription. The fake (`@botsdk/testing/fake-channel`) is one.
 */
export type PushProvider = {
  /** The Host's VAPID public key, base64url: a browser subscribes with it. */
  publicKey: string;
  /**
   * Sends `notification` to `subscription` through `fetch` (the SDK's, which reaches public
   * addresses only). Resolves `gone` when the push service answers 404 or 410, so the subscription
   * is dead; throws on any other refusal.
   */
  send: (
    subscription: PushSubscriptionKeys,
    notification: PushNotification,
    options: { fetch: typeof fetch },
  ) => Promise<"sent" | "gone">;
};

/** The web push Channel as the `channel` plugin takes it. */
export type WebPushChannel = {
  id: "push";
  provider: PushProvider;
  /** The Host app's URL, without a trailing slash: a push opens `<appUrl>/bots/<botId>`. */
  appUrl: string;
};

/**
 * The web push Channel (spec #1024) over `provider`: a Bot's Messages are pushed to each of its
 * user's subscribed devices when the user's notification settings send them there.
 */
export function webPushChannel({
  provider,
  appUrl,
}: {
  provider: PushProvider;
  appUrl: string;
}): WebPushChannel {
  return { id: "push", provider, appUrl: appUrl.replace(/\/+$/, "") };
}
