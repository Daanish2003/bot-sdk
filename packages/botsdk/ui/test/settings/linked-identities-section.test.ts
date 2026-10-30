// @vitest-environment jsdom
import { channelClient } from "@botsdk/client";
import { unlinkIdentityInput } from "@botsdk/client/bot/linked-identity";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { LinkedIdentitiesSection } from "../../src/settings/linked-identities-section";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const at = new Date("2026-10-30T09:00:00.000Z");

/** A stand-in for the server's `channels.identities` procedures, recording unlinks and codes. */
function fakeIdentitiesServer(initial: { platform: string; handle: string }[], offered = true) {
  let identities = initial;
  const unlinked: string[] = [];
  const counts = { codes: 0 };
  const router = {
    channels: {
      identities: {
        list: os.handler(() => {
          if (!offered) throw new ORPCError("NOT_FOUND");
          return identities.map((identity) => ({ ...identity, linkedAt: at }));
        }),
        unlink: os.input(unlinkIdentityInput).handler(({ input }) => {
          unlinked.push(input.platform);
          identities = identities.filter((identity) => identity.platform !== input.platform);
        }),
        linkCode: os.handler(() => {
          counts.codes += 1;
          return {
            code: "482913",
            expiresAt: new Date("2026-10-30T09:10:00.000Z"),
            links: [
              {
                platform: "telegram",
                botId: "b1",
                botName: "Ada",
                handle: "@ada_bot",
                url: "https://t.me/ada_bot?start=482913",
              },
            ],
          };
        }),
      },
    },
  };
  const handler = new RPCHandler(router);
  const fetch = async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
  return { fetch, unlinked, counts };
}

function show(server: ReturnType<typeof fakeIdentitiesServer>) {
  render(
    providerFor(createElement(LinkedIdentitiesSection), {
      features: [channelClient()],
      fetch: server.fetch,
      messages: {},
    }),
  );
}

describe("LinkedIdentitiesSection", () => {
  it("lists the Linked identities, and unlinks one", async () => {
    const server = fakeIdentitiesServer([{ platform: "telegram", handle: "@ada" }]);
    show(server);

    const list = await screen.findByRole("list", { name: "Linked identities" });
    expect(within(list).getByText("Telegram: @ada")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Unlink Telegram" }));

    expect(await screen.findByText("No accounts linked yet.")).toBeTruthy();
    expect(server.unlinked).toEqual(["telegram"]);
  });

  it("shows a link code with its expiry and deep links on Get a link code", async () => {
    const server = fakeIdentitiesServer([]);
    show(server);

    fireEvent.click(await screen.findByRole("button", { name: "Get a link code" }));

    expect(await screen.findByText("482913")).toBeTruthy();
    expect(screen.getByText(/^Expires at /)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Ada on Telegram" }).getAttribute("href")).toBe(
      "https://t.me/ada_bot?start=482913",
    );
    expect(server.counts.codes).toBe(1);
  });

  it("renders nothing when the Host offers no messaging Channel", async () => {
    const server = fakeIdentitiesServer([], false);
    const { container } = render(
      providerFor(createElement(LinkedIdentitiesSection), {
        features: [channelClient()],
        fetch: server.fetch,
        messages: {},
      }),
    );

    await waitFor(() => expect(container.querySelector("section")).toBeNull());
    expect(screen.queryByText("Linked identities")).toBeNull();
  });
});
