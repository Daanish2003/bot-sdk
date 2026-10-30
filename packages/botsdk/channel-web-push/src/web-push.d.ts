// The part of `web-push` 3.6.7 this package uses: it ships no types.
declare module "web-push" {
  type RequestDetails = {
    method: "POST";
    headers: Record<string, string | number>;
    body: Buffer | null;
    endpoint: string;
  };

  const webPush: {
    /** The encrypted request of one push, with its VAPID `Authorization` header, unsent. */
    generateRequestDetails(
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
      payload: string,
      options: {
        vapidDetails: { subject: string; publicKey: string; privateKey: string };
        TTL?: number;
      },
    ): RequestDetails;
    /** A new VAPID key pair, base64url. */
    generateVAPIDKeys(): { publicKey: string; privateKey: string };
  };
  export default webPush;
}
