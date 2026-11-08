import { describe, expect, it } from "vitest";

import { fakeMessagingAdapter } from "@botsdk/testing/fake-channel";
import { createChannels } from "../../src/bot/channels";
import type { BotSdkContext } from "../../src/plugin";

/* What `channels.reach` tells the Outbound gate of a platform: the limits its adapter declares. */

const reachOf = (adapter: object) =>
  createChannels({} as BotSdkContext, {
    adapters: [{ ...fakeMessagingAdapter({ id: "sms" }).adapter, ...adapter }],
    verifiedEmail: async () => null,
  }).reach("sms");

describe("a platform's reach", () => {
  it("carries what the adapter declares, including that it cuts long messages", () => {
    expect(
      reachOf({ canStartConversation: false, maxLength: 459, cutsLongMessages: true }),
    ).toEqual({ canStartConversation: false, maxLength: 459, cutsLongMessages: true });
  });

  it("leaves the cut flag unset when the adapter doesn't declare it", () => {
    expect(reachOf({ maxLength: 459 })?.cutsLongMessages).toBeUndefined();
  });
});
