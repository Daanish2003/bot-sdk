// @vitest-environment jsdom
import { representativeClient, type ChannelAccountsView } from "@botsdk/representative/client";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, Fragment } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ChannelAccountsSection } from "../src/representative/channel-accounts-section";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(cleanup);

const id = "0195c6a0-0000-7000-8000-000000000001";
const accountId = "0195c6a0-0000-7000-8000-000000000002";
const webhookUrl = `https://app.example/api/chat/channels/sms/${accountId}`;

/**
 * A stand-in for the server's `channelAccountList`, with one SMS account on a webhook for `id`
 * and none for another Representative. `listed` counts each Representative's list reads, and
 * `channelAccountRemove` answers with no accounts left.
 */
function fakeServer(listed: Record<string, number> = {}) {
  const view: ChannelAccountsView = {
    voiceOffered: false,
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
        voice: null,
        createdAt: new Date("2026-11-01T00:00:00Z"),
      },
    ],
  };
  const handler = new RPCHandler({
    representative: {
      channelAccountList: os.handler(({ input }) => {
        const of = (input as { id: string }).id;
        listed[of] = (listed[of] ?? 0) + 1;
        return of === id ? view : { ...view, accounts: [] };
      }),
      channelAccountRemove: os.handler(() => ({ ...view, accounts: [] })),
    },
  });
  return async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
}

const other = "0195c6a0-0000-7000-8000-000000000003";

const renderSection = (listed?: Record<string, number>, ...also: string[]) =>
  render(
    providerFor(
      createElement(
        Fragment,
        null,
        [id, ...also].map((of) => createElement(ChannelAccountsSection, { key: of, id: of })),
      ),
      {
        fetch: fakeServer(listed),
        features: [representativeClient()],
        messages: {},
      },
    ),
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

  // What a connect or remove answers is stored, so the list it shows isn't read again; another
  // Representative's is, since an account can move from one to another (#1174 review).
  it("doesn't refetch the list it just stored after a remove, but does another Representative's", async () => {
    const listed: Record<string, number> = {};
    renderSection(listed, other);

    fireEvent.click(await screen.findByRole("button", { name: "Remove +15550001111" }));

    await waitFor(() => expect(listed[other]).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listed[id]).toBe(1);
  });
});

const voiceId = "0195c6a0-0000-7000-8000-000000000009";

/**
 * A stand-in for the voice RPCs: the Host offers voice, an SMS account holds `smsNumber`, and connecting
 * makes one voice account whose secret is only in the answer. `calls` records what each RPC got.
 */
function fakeVoiceServer(
  calls: { connect: unknown[]; regenerate: unknown[]; greeting?: unknown[] },
  connected = false,
  lastCallAt: Date | null = null,
) {
  const sms = {
    id: accountId,
    platform: "sms",
    handle: "+15550001111",
    status: "active" as const,
    reason: null,
    webhookUrl,
    voice: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
  };
  const voiceAccount = {
    id: voiceId,
    platform: "voice",
    handle: "+15550001111",
    status: "active" as const,
    reason: null,
    webhookUrl: null,
    voice: {
      greeting: "Hello, thanks for calling. How can I help?",
      hookUrl: `https://app.example/api/chat/representative/voice/${voiceId}`,
      smsPaired: true,
      lastCallAt,
    },
    createdAt: new Date("2026-11-02T00:00:00Z"),
  };
  let held = connected ? [sms, voiceAccount] : [sms];
  const view = (): ChannelAccountsView => ({
    voiceOffered: true,
    platforms: [{ platform: "sms", fields: ["number"], plainFields: ["number"] }],
    accounts: held,
  });
  const handler = new RPCHandler({
    representative: {
      channelAccountList: os.handler(() => view()),
      voiceAccountConnect: os.handler(({ input }) => {
        calls.connect.push(input);
        held = [sms, voiceAccount];
        return { secret: "first-secret", view: view() };
      }),
      voiceAccountSetGreeting: os.handler(({ input }) => {
        calls.greeting?.push(input);
        voiceAccount.voice.greeting = (input as { greeting: string }).greeting;
        return view();
      }),
      voiceAccountRegenerate: os.handler(({ input }) => {
        calls.regenerate.push(input);
        return { secret: "second-secret", view: view() };
      }),
    },
  });
  return async (request: Request) =>
    (await handler.handle(request, { prefix: "/api/chat/rpc" })).response ??
    new Response(null, { status: 404 });
}

describe("a Representative's phone calls", () => {
  const renderVoice = (calls = { connect: [] as unknown[], regenerate: [] as unknown[] }) => {
    render(
      providerFor(createElement(ChannelAccountsSection, { id }), {
        fetch: fakeVoiceServer(calls),
        features: [representativeClient()],
        messages: {},
      }),
    );
    return calls;
  };

  it("takes calls on the SMS number: the form asks for a number and a greeting, and nothing else", async () => {
    const calls = renderVoice();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Take calls on this number" }));

    // The SMS account's number is there to confirm, and no key of any vendor is asked for.
    expect((screen.getByLabelText("Phone number (E.164)") as HTMLInputElement).value).toBe(
      "+15550001111",
    );
    fireEvent.change(screen.getByLabelText("Greeting"), { target: { value: "Hi there." } });
    expect(screen.queryByLabelText(/key|token|provider/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect calls" }));

    await waitFor(() =>
      expect(calls.connect).toEqual([{ id, number: "+15550001111", greeting: "Hi there." }]),
    );
  });

  it("shows the secret once after connecting, the hook URL and the pairing, and not after a reload", async () => {
    renderVoice();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Take calls on this number" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect calls" }));

    expect(((await screen.findByLabelText("Secret")) as HTMLInputElement).value).toBe(
      "first-secret",
    );
    expect((screen.getByLabelText("Hook URL") as HTMLInputElement).value).toBe(
      `https://app.example/api/chat/representative/voice/${voiceId}`,
    );
    expect(screen.getByText(/Paired with your SMS account/)).toBeTruthy();
    cleanup();

    // A page that reads the account again has no secret to show.
    render(
      providerFor(createElement(ChannelAccountsSection, { id }), {
        fetch: fakeVoiceServer({ connect: [], regenerate: [] }, true),
        features: [representativeClient()],
        messages: {},
      }),
    );
    await screen.findByLabelText("Hook URL");
    expect(screen.queryByLabelText("Secret")).toBeNull();
  });

  it.each([
    ["No calls yet", null],
    ["Last call just now", new Date(Date.now() - 5_000)],
    ["Last call 2 hours ago", new Date(Date.now() - 2 * 3_600_000)],
  ])("reads %s under the account", async (shown, lastCallAt) => {
    render(
      providerFor(createElement(ChannelAccountsSection, { id }), {
        fetch: fakeVoiceServer({ connect: [], regenerate: [] }, true, lastCallAt),
        features: [representativeClient()],
        messages: {},
      }),
    );

    expect(await screen.findByText(shown)).toBeTruthy();
  });

  it("asks before regenerating, then shows the new secret", async () => {
    const calls = renderVoice();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Take calls on this number" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect calls" }));
    await screen.findByLabelText("Secret");

    fireEvent.click(screen.getByRole("button", { name: "Regenerate secret" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(calls.regenerate).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate secret" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Regenerate secret" }));

    await waitFor(() =>
      expect((screen.getByLabelText("Secret") as HTMLInputElement).value).toBe("second-secret"),
    );
    expect(calls.regenerate).toEqual([{ id, channelAccountId: voiceId }]);
  });

  it("changes the greeting from the account row, with the secret left alone", async () => {
    const calls = {
      connect: [] as unknown[],
      regenerate: [] as unknown[],
      greeting: [] as unknown[],
    };
    render(
      providerFor(createElement(ChannelAccountsSection, { id }), {
        fetch: fakeVoiceServer(calls, true),
        features: [representativeClient()],
        messages: {},
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change greeting" }));
    const input = screen.getByLabelText("Greeting") as HTMLInputElement;
    expect(input.value).toBe("Hello, thanks for calling. How can I help?");
    fireEvent.change(input, { target: { value: "Hi, Front desk here." } });
    fireEvent.click(screen.getByRole("button", { name: "Save greeting" }));

    await waitFor(() =>
      expect(calls.greeting).toEqual([
        { id, channelAccountId: voiceId, greeting: "Hi, Front desk here." },
      ]),
    );
    expect(await screen.findByText("Greeting: Hi, Front desk here.")).toBeTruthy();
    expect(calls.regenerate).toEqual([]);
    expect(screen.queryByLabelText("Secret")).toBeNull();
  });
});
