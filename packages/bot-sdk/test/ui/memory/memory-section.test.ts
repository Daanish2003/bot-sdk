// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import type { BotSdkClientPlugin } from "../../../core/client/plugin";
import { assistantClient } from "../../../plugins/assistant/client/index";
import { memoryClient } from "../../../plugins/memory/client/index";
import { MemorySection } from "../../../plugins/memory/ui/memory-section";
import { modelsClient } from "../../../plugins/models/client/index";
import { HostKeysPage } from "../host-keys-page";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function seed(enabled = true) {
  return (queryClient: QueryClient, client: BotSdkClient) => {
    queryClient.setQueryData(client.orpc.memory.status.queryKey(), {
      enabled,
      botMemoryAvailable: true,
    });
  };
}

/** A fetch that never answers, so only the seeded data shows; calls are recorded. */
function recordingFetch() {
  const calls: string[] = [];
  const fetch = vi.fn((input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Promise<Response>(() => {});
  });
  return { fetch, calls };
}

function renderSection(enabled = true, fetch = recordingFetch().fetch) {
  return render(
    providerFor(createElement(MemorySection), {
      seed: seed(enabled),
      fetch,
      // English, not the wrapped test dictionary, so the copy reads as a user sees it.
      messages: {},
    }),
  );
}

describe("MemorySection", () => {
  it("is on the keys page only when the Host installs the memory plugin", () => {
    const page = (plugins: BotSdkClientPlugin[]) =>
      render(
        providerFor(createElement(HostKeysPage), {
          seed: seed(),
          fetch: recordingFetch().fetch,
          messages: {},
          plugins,
        }),
      );

    page([modelsClient(), assistantClient()]);
    expect(screen.queryByRole("switch", { name: "Use and make Memories" })).toBeNull();
    cleanup();

    page([modelsClient(), assistantClient(), memoryClient()]);
    expect(screen.getByRole("switch", { name: "Use and make Memories" })).toBeTruthy();
  });

  it("shows the switch with its state, and no list of Memories", () => {
    renderSection(false);

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows the Memory-off banner", () => {
    renderSection(false);

    expect(screen.getByText(/Memory is off/)).toBeTruthy();
  });

  it("turns Memory off from the switch", async () => {
    const { fetch, calls } = recordingFetch();
    renderSection(true, fetch);

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(calls.some((url) => url.includes("memory/setEnabled"))).toBe(true));
  });
});
