// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import { assistantClient } from "../../../plugins/assistant/client/index";
import { botClient } from "../../../plugins/bot/client/index";
import type { BotMessage, BotTurnProvenance } from "../../../plugins/bot/shared/turn";
import { BotConversation } from "../../../plugins/bot/ui/bot-conversation";
import { memoryClient } from "../../../plugins/memory/client/index";
import type { BotMemoryChange } from "../../../plugins/memory/shared/changes";
import { BotMemoryChip, BotMemoryLive } from "../../../plugins/memory/ui/bot-memory-chip";
import { modelsClient } from "../../../plugins/models/client/index";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const changes: BotMemoryChange[] = [
  { kind: "remembered", tier: "profile", text: "Lives in Berlin" },
  { kind: "changed", tier: "notes", from: "Waiting on the landlord", text: "Landlord replied" },
  { kind: "forgot", tier: "log", text: "Moved flat" },
];

const plugins = [modelsClient(), assistantClient(), memoryClient(), botClient()];

describe("BotMemoryChip", () => {
  it("shows the count and expands to the three kinds, each with its tier", () => {
    render(providerFor(createElement(BotMemoryChip, { changes }), { messages: {}, plugins }));

    fireEvent.click(screen.getByRole("button", { name: /Memory updated · 3/ }));

    expect(screen.getByText(/^Remembered:/).textContent).toBe(
      "Remembered: Lives in Berlin (Profile)",
    );
    const changed = screen.getByText(/^Changed:/);
    expect(changed.textContent).toBe("Changed: Waiting on the landlord → Landlord replied (Notes)");
    expect(changed.querySelector("s")?.textContent).toBe("Waiting on the landlord");
    expect(screen.getByText(/^Forgot:/).textContent).toBe("Forgot: Moved flat (Log)");
    expect(screen.queryByText(/undo/i)).toBeNull();
  });

  it("shows nothing when the pass changed nothing", () => {
    for (const none of [null, []]) {
      const { container, unmount } = render(
        providerFor(createElement(BotMemoryChip, { changes: none }), { messages: {}, plugins }),
      );
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });
});

const createdAt = new Date("2026-10-20T09:00:00.000Z");
const at = (minute: number) => new Date(createdAt.getTime() + minute * 60_000);
const said = (id: string, role: BotMessage["role"], text: string, minute: number): BotMessage => ({
  id,
  role,
  text,
  createdAt: at(minute),
});
const turn = (
  id: string,
  minute: number,
  memoryChanges: BotMemoryChange[] | null,
): BotTurnProvenance => ({
  id,
  status: "complete",
  startedAt: at(minute),
  endedAt: at(minute + 1),
  sent: true,
  triggers: [{ source: "user", channel: "web", routineName: null, at: at(minute) }],
  memoryChanges,
});

/** A fetch that never answers, recording each request's URL. */
function recordingFetch() {
  const urls: string[] = [];
  const fetch = vi.fn(async (request: Request) => {
    urls.push(request.url);
    return new Promise<Response>(() => {});
  });
  return { fetch, urls };
}

const seedGet = (queryClient: QueryClient, client: BotSdkClient, turns: BotTurnProvenance[]) =>
  queryClient.setQueryData(client.orpc.bot.get.queryKey({ input: { botId: "b2" } }), {
    bot: {
      id: "b2",
      name: "Ada",
      model: "openai:gpt-5.6",
      createdAt,
      turnStatus: "complete" as const,
      userTurnStatus: "complete" as const,
    },
    conversationId: "c1",
    messages: [
      said("m1", "user", "I moved to Berlin", 0),
      said("m2", "assistant", "Noted!", 0.5),
      said("m3", "user", "Thanks", 5),
      said("m4", "assistant", "Anytime", 5.5),
    ],
    turns,
  });

describe("the Memory updated chip on a Bot's Turn", () => {
  it("sits under the Bot Message of the Turn whose pass changed memory, and only there", () => {
    render(
      providerFor(
        createElement(BotConversation, {
          botId: "b2",
          afterTurn: (t: BotTurnProvenance) =>
            createElement(BotMemoryChip, { changes: t.memoryChanges }),
        }),
        {
          messages: {},
          plugins,
          fetch: recordingFetch().fetch,
          seed: (queryClient, client) =>
            seedGet(queryClient, client, [turn("t1", 0, changes), turn("t2", 5, null)]),
        },
      ),
    );

    const chips = screen.getAllByRole("button", { name: /Memory updated/ });
    expect(chips).toHaveLength(1);
    const reply = document.querySelector('[data-id="m2"]')!;
    expect(reply.nextElementSibling?.contains(chips[0]!)).toBe(true);
  });
});

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

describe("BotMemoryLive", () => {
  it("refetches the Conversation when the pass announces its changes, and stops with the view", async () => {
    FakeEventSource.all = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const { fetch, urls } = recordingFetch();
    const { unmount } = render(
      providerFor(createElement(BotMemoryLive, { botId: "b2" }), {
        messages: {},
        plugins,
        fetch,
        seed: (queryClient, client) => seedGet(queryClient, client, [turn("t1", 0, null)]),
      }),
    );

    await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
    expect(FakeEventSource.all[0]!.url).toBe("http://localhost/api/chat/events?conversationId=c1");
    const getCalls = () => urls.filter((url) => url.includes("bot/get")).length;
    const before = getCalls();
    FakeEventSource.all[0]!.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "bot_memory_updated", turnId: "t1", changes }),
      }),
    );
    await waitFor(() => expect(getCalls()).toBe(before + 1));

    unmount();
    expect(FakeEventSource.all[0]!.closed).toBe(true);
  });
});
