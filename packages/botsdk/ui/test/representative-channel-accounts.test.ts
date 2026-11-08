// @vitest-environment jsdom
import { representativeClient, type ChannelAccountsView } from "@botsdk/representative/client";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ChannelAccountsSection } from "../src/representative/channel-accounts-section";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const id = "0195c6a0-0000-7000-8000-000000000001";
const accountId = "0195c6a0-0000-7000-8000-000000000002";
const webhookUrl = `https://app.example/api/chat/channels/sms/${accountId}`;

/** A stand-in for the server's `channelAccountList`, with one SMS account on a webhook. */
function fakeServer() {
  const view: ChannelAccountsView = {
    platforms: [
      { platform: "sms", fields: ["apiKey", "publicKey", "number"], plainFields: ["number"] },
    ],
    accounts: [
      {
        id: accountId,
        platform: "sms",
        handle: "+15550001111",
        status: "active",
        reason: null,
        webhookUrl,
        createdAt: new Date("2026-11-01T00:00:00Z"),
      },
    ],
  };
  const handler = new RPCHandler({
    representative: { channelAccountList: os.handler(() => view) },
  });
  return async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
}

const renderSection = () =>
  render(
    providerFor(createElement(ChannelAccountsSection, { id }), {
      fetch: fakeServer(),
      features: [representativeClient()],
      messages: {},
    }),
  );

describe("a Representative's Channel accounts section", () => {
  it("shows a webhook account's URL to copy into the platform", async () => {
    renderSection();

    const url = (await screen.findByLabelText("Webhook URL for +15550001111")) as HTMLInputElement;
    expect(url.value).toBe(webhookUrl);
    expect(url.readOnly).toBe(true);
  });

  it("names SMS as SMS, and shows the number as typed but keeps the keys hidden", async () => {
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Connect SMS" }));

    expect((screen.getByLabelText("Number") as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText("ApiKey") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("PublicKey") as HTMLInputElement).type).toBe("password");
  });
});
