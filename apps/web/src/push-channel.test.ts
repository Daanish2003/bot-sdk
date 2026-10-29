import { describe, expect, it } from "vitest";

import { webPushChannelsOf } from "./push-channel";

const keys = {
  VAPID_PUBLIC_KEY: "BPublicKey",
  VAPID_PRIVATE_KEY: "private-key",
  VAPID_SUBJECT: "mailto:host@example.com",
  BETTER_AUTH_URL: "https://app.example",
};

describe("webPushChannelsOf", () => {
  it("is the web push Channel over the Host's VAPID key pair", () => {
    const [push, ...rest] = webPushChannelsOf(keys);

    expect(rest).toEqual([]);
    expect(push).toMatchObject({ id: "push", appUrl: "https://app.example" });
    expect(push!.provider.publicKey).toBe("BPublicKey");
  });

  it.each(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const)(
    "is none without %s, so no push is offered",
    (unset) => {
      expect(webPushChannelsOf({ ...keys, [unset]: undefined })).toEqual([]);
    },
  );
});
