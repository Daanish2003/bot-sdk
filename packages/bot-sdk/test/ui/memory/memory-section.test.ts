// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemorySection } from "@botsdk/ui/memory/memory-section";
import { providerFor, type TestClient } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function seed(enabled = true) {
  return (queryClient: QueryClient, client: TestClient) => {
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
