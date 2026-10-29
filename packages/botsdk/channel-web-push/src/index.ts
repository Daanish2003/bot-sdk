// oxlint-disable-next-line typescript/triple-slash-reference -- a Host typechecks this source, so the module's types travel with it
/// <reference path="./web-push.d.ts" />
import webPush from "web-push";

import type { PushProvider } from "@botsdk/bot/channel/internal";

/** How long a call to a push service may take before it is given up on. */
const timeoutMs = 10_000;

/** What a push service answers for a subscription no push can reach. */
const goneStatuses = new Set([403, 404, 410]);

/** How long a push service keeps a push for a device that is offline: a day. */
const ttlSeconds = 24 * 60 * 60;

/**
 * The web push provider (spec #1024) over `web-push`: it encrypts each push for the device's keys
 * (RFC 8291) and signs it with the Host's VAPID key pair (RFC 8292), then POSTs it to the device's
 * push service with the `fetch` the SDK gives it. The subscription is gone when the push service
 * answers 404 or 410, or 403 (it was made with another VAPID key, so no push to it can succeed), and
 * when its keys can't be encrypted for.
 */
export function webPushProvider({
  publicKey,
  privateKey,
  subject,
}: {
  /** The Host's VAPID key pair, base64url, as `web-push generate-vapid-keys` prints it. */
  publicKey: string;
  privateKey: string;
  /** The Host's contact, a `mailto:` or `https:` URL, which push services may write to. */
  subject: string;
}): PushProvider {
  const vapidDetails = { subject, publicKey, privateKey };
  return {
    publicKey,
    send: async (subscription, notification, { fetch: fetcher }) => {
      let request;
      try {
        request = webPush.generateRequestDetails(subscription, JSON.stringify(notification), {
          vapidDetails,
          TTL: ttlSeconds,
        });
      } catch {
        // Keys of the wrong length: no retry can encrypt for them.
        return "gone";
      }
      // `fetch` sets the length itself, from the body.
      const headers = Object.fromEntries(
        Object.entries(request.headers)
          .filter(([name]) => name.toLowerCase() !== "content-length")
          .map(([name, value]) => [name, String(value)]),
      );
      const response = await fetcher(request.endpoint, {
        method: request.method,
        headers,
        body: request.body && new Uint8Array(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (goneStatuses.has(response.status)) {
        await response.body?.cancel();
        return "gone";
      }
      if (!response.ok) {
        throw new Error(
          `The push service refused the push (${response.status}): ${await response.text()}`,
        );
      }
      await response.body?.cancel();
      return "sent";
    },
  };
}
