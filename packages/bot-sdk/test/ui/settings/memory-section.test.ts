// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import { MemorySection } from "../../../plugins/assistant/ui/settings/memory-section";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const general = {
  id: "m1",
  text: "Lives in Pune",
  origin: "extracted" as const,
  createdAt: new Date("2026-10-01T09:00:00.000Z"),
  conversationId: "c1",
  conversationTitle: "Dinner ideas",
  sourceMessageId: "msg1",
};
const asked = {
  id: "m2",
  text: "Is vegetarian",
  origin: "said" as const,
  createdAt: new Date("2026-10-02T09:00:00.000Z"),
  conversationId: "c2",
  conversationTitle: null,
  sourceMessageId: "msg2",
};
const thesis = {
  id: "m3",
  text: "Advisor is Dr. Rao",
  origin: "extracted" as const,
  createdAt: new Date("2026-10-03T09:00:00.000Z"),
  conversationId: "c3",
  conversationTitle: "Chapter two",
  sourceMessageId: "msg3",
};

const groups = [
  { projectId: null, projectName: null, items: [general, asked] },
  { projectId: "p1", projectName: "Thesis", items: [thesis] },
];

type Seed = {
  hostEnabled?: boolean;
  enabled?: boolean;
  embeddingAvailable?: boolean;
  groups?: typeof groups;
};

function seed(overrides: Seed = {}) {
  return (queryClient: QueryClient, client: BotSdkClient) => {
    queryClient.setQueryData(client.orpc.memory.status.queryKey(), {
      hostEnabled: overrides.hostEnabled ?? true,
      enabled: overrides.enabled ?? true,
      embeddingAvailable: overrides.embeddingAvailable ?? true,
    });
    queryClient.setQueryData(client.orpc.memory.list.queryKey(), {
      groups: overrides.groups ?? groups,
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

function renderSection(options: Seed = {}, fetch = recordingFetch().fetch) {
  return render(
    providerFor(createElement(MemorySection), {
      seed: seed(options),
      fetch,
      // English, not the wrapped test dictionary, so the copy reads as a user sees it.
      messages: {},
    }),
  );
}

describe("MemorySection", () => {
  it("is hidden when the Host turns Memory off", () => {
    const { container } = renderSection({ hostEnabled: false });

    expect(container.innerHTML).toBe("");
  });

  it("lists General first, then each Project, with counts", () => {
    const { container } = renderSection();

    const headings = [...container.querySelectorAll("h3")].map((h) => h.textContent);
    expect(headings).toEqual(["General2", "Project · Thesis1"]);
    expect(screen.getByText("Lives in Pune")).toBeTruthy();
    expect(screen.getByText("Advisor is Dr. Rao")).toBeTruthy();
  });

  it("marks what the user asked to remember, and links each Memory to its source Message", () => {
    renderSection();

    expect(screen.getByText(/You asked me to remember this/)).toBeTruthy();
    expect(screen.getByText("from Dinner ideas")).toBeTruthy();
    expect(screen.getByText("from Untitled")).toBeTruthy();
  });

  it("shows the switch with its state", () => {
    renderSection({ enabled: false });

    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("shows the Memory-off banner and keeps the Memories listed", () => {
    renderSection({ enabled: false });

    expect(screen.getByText(/Memory is off/)).toBeTruthy();
    expect(screen.getByText("Lives in Pune")).toBeTruthy();
  });

  it("shows the no-embedding-Model banner, and says to add an OpenAI or Gemini key", () => {
    renderSection({ embeddingAvailable: false });

    expect(screen.getByText(/Add an OpenAI or Gemini key/)).toBeTruthy();
  });

  it("shows the empty state when there are no Memories", () => {
    renderSection({ groups: [] });

    expect(
      screen.getByText("No Memories yet. Chat as usual, or say 'remember that…'"),
    ).toBeTruthy();
  });

  it("edits inline: Escape cancels without a request", () => {
    const { fetch, calls } = recordingFetch();
    renderSection({}, fetch);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit Memory" })[0]!);
    const input = screen.getByRole("textbox", { name: "Edit Memory" }) as HTMLInputElement;
    expect(input.value).toBe("Lives in Pune");
    fireEvent.change(input, { target: { value: "Lives in Mumbai" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Edit Memory" })).toBeNull();
    expect(screen.getByText("Lives in Pune")).toBeTruthy();
    expect(calls.some((url) => url.includes("memory/edit"))).toBe(false);
  });

  it("edits inline: Enter saves the changed text", async () => {
    const { fetch, calls } = recordingFetch();
    renderSection({}, fetch);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit Memory" })[0]!);
    const input = screen.getByRole("textbox", { name: "Edit Memory" });
    fireEvent.change(input, { target: { value: "Lives in Mumbai" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calls.some((url) => url.includes("memory/edit"))).toBe(true));
  });

  it("deletes all only after confirming, and cancelling keeps them", () => {
    const { fetch, calls } = recordingFetch();
    renderSection({}, fetch);

    fireEvent.click(screen.getByRole("button", { name: "Delete all Memories" }));
    expect(screen.getByText(/Delete every Memory for good/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Lives in Pune")).toBeTruthy();
    expect(calls.some((url) => url.includes("memory/deleteAll"))).toBe(false);
  });
});
