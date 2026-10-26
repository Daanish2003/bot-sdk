// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import { knowledgeClient } from "../../../plugins/knowledge/client/index";
import { KnowledgeChip } from "../../../plugins/knowledge/ui/knowledge-chip";
import { providerFor } from "../fake-dictionary";

afterEach(cleanup);

const features = [knowledgeClient()];
const changes = [{ botId: "ada", path: "reports/q3.md" }];

function seeded(queryClient: QueryClient, client: BotSdkClient) {
  queryClient.setQueryData(client.orpc.bots.get.queryKey({ input: { botId: "ada" } }), {
    bot: { id: "ada", name: "Ada" },
  } as never);
}

function renderChip(
  props: { changes: { botId: string; path: string }[] | null },
  fetch: typeof globalThis.fetch = vi.fn(async () => new Response()),
) {
  return render(
    providerFor(createElement(KnowledgeChip, { botId: "ada", ...props }), {
      seed: seeded,
      fetch,
      messages: {},
      features,
    }),
  );
}

describe("KnowledgeChip", () => {
  it("shows a quiet chip per saved file, collapsed", () => {
    renderChip({ changes });
    const chip = screen.getByRole("button", { name: "📚 Ada saved to Knowledge: reports/q3.md" });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows nothing when the Turn saved no Knowledge", () => {
    for (const none of [null, []]) {
      const { container, unmount } = renderChip({ changes: none });
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });

  it("expands to the path, size and readable text, with Delete", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ json: { path: "reports/q3.md", content: "Revenue grew.", size: 2048 } }),
    );
    renderChip({ changes }, fetch);
    fireEvent.click(screen.getByRole("button", { name: /saved to Knowledge/ }));

    await waitFor(() => expect(screen.getByText("Revenue grew.")).toBeTruthy());
    expect(screen.getByText("2 KB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /saved to Knowledge/ }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("Delete removes the file and closes the chip's details", async () => {
    const bodies: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      bodies.push(`${request.url} ${await request.clone().text()}`);
      return request.url.includes("/read")
        ? Response.json({ json: { path: "reports/q3.md", content: "Revenue grew.", size: 13 } })
        : new Response();
    });
    renderChip({ changes }, fetch);
    fireEvent.click(screen.getByRole("button", { name: /saved to Knowledge/ }));
    await waitFor(() => screen.getByText("Revenue grew."));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(bodies.some((entry) => entry.includes("remove"))).toBe(true));
    expect(bodies.find((entry) => entry.includes("remove"))).toContain("reports/q3.md");
  });
});
