// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import { assistantClient } from "../../../plugins/assistant/client/index";
import { botClient } from "../../../plugins/bot/client/index";
import { memoryClient } from "../../../plugins/memory/client/index";
import { BotMemoryPopover } from "../../../plugins/memory/ui/bot-memory-popover";
import { modelsClient } from "../../../plugins/models/client/index";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const list = {
  available: true,
  enabled: true,
  profile: [
    { botId: "ada", botName: null, line: 1, text: "Lives in Berlin", inPrompt: true },
    { botId: "bea", botName: "Bea", line: 1, text: "Is vegan", inPrompt: false },
  ],
  log: [
    {
      month: "2030-03",
      line: 1,
      text: "2030-03-10 (importance 8) Moved flat",
      body: "Moved flat",
      date: "2030-03-10",
      importance: 8,
      inPrompt: true,
    },
  ],
  notes: [
    {
      line: 1,
      text: "2030-03-15 Waiting on the landlord",
      body: "Waiting on the landlord",
      date: "2030-03-15",
      inPrompt: true,
    },
  ],
};

/** A fetch that never answers, recording each request's path and body. */
function recordingFetch() {
  const calls: { url: string; body: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({ url: request.url, body: await request.clone().text() });
    return new Promise<Response>(() => {});
  });
  return { fetch, calls };
}

const calledWith = (calls: { url: string; body: string }[], procedure: string) =>
  calls.find((call) => call.url.includes(`memory/${procedure}`));

function renderPopover(
  {
    data = list,
    file = "- Lives in Berlin\n",
    botMemoryAvailable = true,
  }: { data?: typeof list; file?: string; botMemoryAvailable?: boolean } = {},
  fetch = recordingFetch().fetch,
) {
  render(
    providerFor(createElement(BotMemoryPopover, { botId: "ada" }), {
      seed: (queryClient: QueryClient, client: BotSdkClient) => {
        queryClient.setQueryData(client.orpc.memory.status.queryKey(), {
          enabled: true,
          botMemoryAvailable,
        });
        queryClient.setQueryData(
          client.orpc.memory.botList.queryKey({ input: { botId: "ada" } }),
          data,
        );
        queryClient.setQueryData(
          client.orpc.memory.botReadFile.queryKey({
            input: { file: { botId: "ada", tier: "profile" } },
          }),
          { content: file },
        );
      },
      fetch,
      messages: {},
      plugins: [modelsClient(), assistantClient(), memoryClient(), botClient()],
    }),
  );
  const button = screen.queryByRole("button", { name: "Memory" });
  if (button) fireEvent.click(button);
}

describe("BotMemoryPopover", () => {
  it("shows the Profile, Log and Notes with the other Bots' lines labelled and the dots", () => {
    renderPopover();

    expect(screen.getByRole("region", { name: "Profile" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Log" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Notes" })).toBeTruthy();
    expect(screen.getByText("Lives in Berlin")).toBeTruthy();
    expect(screen.getByText("· Bea")).toBeTruthy();
    expect(screen.getByText("importance 8")).toBeTruthy();
    expect(screen.getByText(/Moved flat/).textContent).toContain("2030-03-10");
    const dots = screen.getAllByRole("img").map((dot) => dot.getAttribute("data-in-prompt"));
    expect(dots).toEqual(["true", "false", "true", "true"]);
  });

  it("says Memory is off with the switch off", () => {
    renderPopover({ data: { available: true, enabled: false, profile: [], log: [], notes: [] } });

    expect(screen.getByRole("status").textContent).toMatch(/Memory is off/);
    expect(screen.queryByRole("region", { name: "Profile" })).toBeNull();
  });

  it("has no Memory button without the computer plugin", () => {
    renderPopover({ botMemoryAvailable: false });

    expect(screen.queryByRole("button", { name: "Memory" })).toBeNull();
  });

  it("filters the lines", () => {
    renderPopover();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter memory" }), {
      target: { value: "vegan" },
    });

    expect(screen.queryByText("Lives in Berlin")).toBeNull();
    expect(screen.getByText("Is vegan")).toBeTruthy();
  });

  it("edits a line in place: Enter calls the router with the line's current text", async () => {
    const { fetch, calls } = recordingFetch();
    renderPopover({}, fetch);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit line" })[0]!);
    const input = screen.getByRole("textbox", { name: "Edit line" });
    fireEvent.change(input, { target: { value: "Lives in Pune" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calledWith(calls, "botEditLine")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "botEditLine")!.body).json).toEqual({
      file: { botId: "ada", tier: "profile" },
      line: 1,
      current: "Lives in Berlin",
      text: "Lives in Pune",
    });
  });

  it("cancels an edit with Escape, with no request", () => {
    const { fetch, calls } = recordingFetch();
    renderPopover({}, fetch);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit line" })[0]!);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit line" }), { key: "Escape" });

    expect(screen.getByText("Lives in Berlin")).toBeTruthy();
    expect(calledWith(calls, "botEditLine")).toBeUndefined();
  });

  it("deletes another Bot's Profile line", async () => {
    const { fetch, calls } = recordingFetch();
    renderPopover({}, fetch);

    fireEvent.click(screen.getAllByRole("button", { name: "Delete line" })[1]!);

    await waitFor(() => expect(calledWith(calls, "botDeleteLine")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "botDeleteLine")!.body).json).toEqual({
      file: { botId: "bea", tier: "profile" },
      line: 1,
      current: "Is vegan",
    });
  });

  it("adds a line to a section", async () => {
    const { fetch, calls } = recordingFetch();
    renderPopover({}, fetch);

    const notes = screen.getByRole("region", { name: "Notes" });
    const box = within(notes).getByRole("textbox", { name: "Add to Notes" });
    fireEvent.change(box, { target: { value: "Feed the cat" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(calledWith(calls, "botAddLine")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "botAddLine")!.body).json).toEqual({
      botId: "ada",
      tier: "notes",
      text: "Feed the cat",
    });
  });

  it("opens a section as a file and saves it whole", async () => {
    const { fetch, calls } = recordingFetch();
    renderPopover({}, fetch);

    const profile = screen.getByRole("region", { name: "Profile" });
    fireEvent.click(within(profile).getByRole("button", { name: "View as file: Profile" }));
    const file = within(profile).getByRole("textbox", {
      name: "Profile file",
    }) as HTMLTextAreaElement;
    expect(file.value).toBe("- Lives in Berlin\n");
    const save = within(profile).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(file, { target: { value: "- Lives in Pune\n" } });
    fireEvent.click(save);

    await waitFor(() => expect(calledWith(calls, "botSaveFile")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "botSaveFile")!.body).json).toEqual({
      file: { botId: "ada", tier: "profile" },
      expected: "- Lives in Berlin\n",
      content: "- Lives in Pune\n",
    });
  });
});
