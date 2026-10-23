// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotSdkClient } from "../../../core/client/chat-client";
import { botClient } from "../../../plugins/bot/client/index";
import { modelsClient } from "../../../plugins/models/client/index";
import { skillsClient } from "../../../plugins/skills/client/index";
import { BotSkillChip } from "../../../plugins/skills/ui/bot-skill-chip";
import { BotSkillsPopover } from "../../../plugins/skills/ui/bot-skills-popover";
import { providerFor } from "../fake-dictionary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const plugins = [modelsClient(), skillsClient(), botClient()];
const modified = new Date("2030-03-15T12:00:00Z");
const path = (name: string) => `/home/user/bots/ada/skills/${name}/SKILL.md`;
const invoices =
  "---\nname: invoices\ndescription: Use this when an invoice arrives.\n---\n\n## Steps\n1. File it.\n";

const list = [
  {
    name: "bare",
    description: null,
    problem: "no frontmatter",
    lastModified: modified,
  },
  {
    name: "invoices",
    description: "Use this when an invoice arrives.",
    problem: null,
    lastModified: modified,
  },
];

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
  calls.find((call) => call.url.includes(`skills/${procedure}`));

/** Seeds the Bot's Skills, and the SKILL.md of each in `files`. */
function seeded(files: Record<string, string>, available = true) {
  return (queryClient: QueryClient, client: BotSdkClient) => {
    queryClient.setQueryData(client.orpc.skills.status.queryKey(), { available });
    queryClient.setQueryData(client.orpc.skills.list.queryKey({ input: { botId: "ada" } }), list);
    for (const [name, content] of Object.entries(files)) {
      queryClient.setQueryData(
        client.orpc.skills.read.queryKey({ input: { botId: "ada", name } }),
        { content, path: path(name), lastModified: modified },
      );
    }
  };
}

function renderPopover(fetch = recordingFetch().fetch, available = true) {
  render(
    providerFor(createElement(BotSkillsPopover, { botId: "ada" }), {
      seed: seeded({ invoices, bare: "No frontmatter." }, available),
      fetch,
      messages: {},
      plugins,
    }),
  );
  const button = screen.queryByRole("button", { name: /^Skills/ });
  if (button) fireEvent.click(button);
}

describe("BotSkillsPopover", () => {
  it("lists the Skills with a not usable badge and its reason", () => {
    renderPopover();

    expect(screen.getByRole("button", { name: "Skills 2" })).toBeTruthy();
    expect(screen.getByText("Use this when an invoice arrives.")).toBeTruthy();
    const bare = screen.getByRole("button", { name: /bare/ });
    expect(within(bare).getByText("not usable")).toBeTruthy();
    expect(within(bare).getByText("no frontmatter")).toBeTruthy();
  });

  it("has no Skills button without the computer plugin", () => {
    renderPopover(recordingFetch().fetch, false);

    expect(screen.queryByRole("button", { name: /^Skills/ })).toBeNull();
  });

  it("expands a row to the editor: the raw text, its path, when it changed, Save and Delete", () => {
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: /invoices/ }));

    const file = screen.getByRole("textbox", { name: "SKILL.md" }) as HTMLTextAreaElement;
    expect(file.value).toBe(invoices);
    expect(screen.getByText(path("invoices"), { exact: false })).toBeTruthy();
    expect(screen.getByText(/Last modified/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("saves the edited text under the Skill's name", async () => {
    const { fetch, calls } = recordingFetch();
    renderPopover(fetch);

    fireEvent.click(screen.getByRole("button", { name: /invoices/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "SKILL.md" }), {
      target: { value: "new text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calledWith(calls, "save")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "save")!.body).json).toEqual({
      botId: "ada",
      name: "invoices",
      content: "new text",
    });
  });

  it("shows why a saved Skill is not usable", async () => {
    const answer = vi.fn(async () =>
      Response.json({ json: { problem: 'description must start with "Use this when"' } }),
    );
    renderPopover(answer);

    fireEvent.click(screen.getByRole("button", { name: /invoices/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "SKILL.md" }), {
      target: { value: "---\nname: invoices\ndescription: Logs.\n---\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      'Not usable: description must start with "Use this when"',
    );
  });

  it("deletes the Skill", async () => {
    const { fetch, calls } = recordingFetch();
    renderPopover(fetch);

    fireEvent.click(screen.getByRole("button", { name: /invoices/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(calledWith(calls, "remove")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "remove")!.body).json).toEqual({
      botId: "ada",
      name: "invoices",
    });
  });

  it("starts New Skill from a template whose description begins Use this when", async () => {
    const { fetch, calls } = recordingFetch();
    renderPopover(fetch);

    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Skill name" }), {
      target: { value: "weekly-report" },
    });
    const file = screen.getByRole("textbox", { name: "SKILL.md" }) as HTMLTextAreaElement;
    expect(file.value).toContain("name: weekly-report\n");
    expect(file.value).toContain("description: Use this when");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calledWith(calls, "save")).toBeTruthy());
    expect(JSON.parse(calledWith(calls, "save")!.body).json).toMatchObject({
      botId: "ada",
      name: "weekly-report",
      content: file.value,
    });
  });
});

describe("New Skill that is not usable", () => {
  it("stays open and shows the reason", async () => {
    const answer = vi.fn(async (input: RequestInfo | URL) =>
      String(input instanceof Request ? input.url : input).includes("skills/save")
        ? Response.json({ json: { problem: "no frontmatter" } })
        : new Promise<Response>(() => {}),
    );
    renderPopover(answer);

    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Skill name" }), {
      target: { value: "weekly-report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Not usable: no frontmatter");
    expect(screen.getByRole("textbox", { name: "Skill name" })).toBeTruthy();
  });
});

describe("BotSkillChip editor", () => {
  it("expands in place to the same editor", () => {
    render(
      providerFor(
        createElement(BotSkillChip, {
          botId: "ada",
          changes: [{ kind: "updated", name: "invoices" }],
        }),
        { seed: seeded({ invoices }), messages: {}, plugins },
      ),
    );
    expect(screen.queryByRole("textbox", { name: "SKILL.md" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "📘 Skill updated: invoices" }));

    expect((screen.getByRole("textbox", { name: "SKILL.md" }) as HTMLTextAreaElement).value).toBe(
      invoices,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "📘 Skill updated: invoices" }));
    expect(screen.queryByRole("textbox", { name: "SKILL.md" })).toBeNull();
  });
});
