// @vitest-environment jsdom
import type { OpenaiCredentialsState } from "@botsdk/client/models/credentials/services";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinkedCredentialsHost } from "../../plugins/models/ui/key-settings";
import { HostKeysPage } from "./host-keys-page";
import { providerFor, renderEnglish, renderWrapped } from "./fake-dictionary";

afterEach(() => {
  cleanup();
});

function seedKeys(state?: OpenaiCredentialsState, saved = state === "key") {
  return (
    queryClient: Parameters<NonNullable<Parameters<typeof renderWrapped>[1]>["seed"] & {}>[0],
    client: Parameters<NonNullable<Parameters<typeof renderWrapped>[1]>["seed"] & {}>[1],
  ) => {
    queryClient.setQueryData(client.orpc.models.credentials.mode.queryKey(), { byok: true });
    queryClient.setQueryData(
      client.orpc.models.credentials.list.queryKey(),
      saved ? [{ service: "openai", hint: "…abcd", verified: true }] : [],
    );
    if (state)
      queryClient.setQueryData(client.orpc.models.credentials.openaiState.queryKey(), state);
  };
}

const host = (): LinkedCredentialsHost => ({ connect: vi.fn(), disconnect: vi.fn() });

function page(linked: LinkedCredentialsHost | undefined, state?: OpenaiCredentialsState) {
  return render(
    providerFor(createElement(HostKeysPage, { linkedCredentials: linked }), {
      messages: {},
      seed: seedKeys(state),
    }),
  );
}

describe("the OpenAI row's ChatGPT link", () => {
  it("offers Connect ChatGPT when nothing is linked, and calls the Host's connect", async () => {
    const linked = host();
    page(linked, "none");

    fireEvent.click(screen.getByRole("button", { name: "Connect ChatGPT" }));

    await waitFor(() => expect(linked.connect).toHaveBeenCalledOnce());
  });

  it("shows Connected via ChatGPT with Disconnect, which calls the Host's disconnect", async () => {
    const linked = host();
    page(linked, "linked");

    expect(screen.getByText("Connected via ChatGPT")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect ChatGPT" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect ChatGPT" }));

    await waitFor(() => expect(linked.disconnect).toHaveBeenCalledOnce());
  });

  it("also offers Reconnect on a linked row, for a token that was revoked before it expired", async () => {
    const linked = host();
    page(linked, "linked");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect ChatGPT" }));

    await waitFor(() => expect(linked.connect).toHaveBeenCalledOnce());
  });

  it("offers Reconnect when the link is broken, which calls the Host's connect", async () => {
    const linked = host();
    page(linked, "needs-reconnect");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect ChatGPT" }));

    await waitFor(() => expect(linked.connect).toHaveBeenCalledOnce());
  });

  it("shows the saved key, noting it is used even though ChatGPT is linked", () => {
    page(host(), "key");

    expect(screen.getByText("…abcd")).toBeTruthy();
    expect(screen.getByText(/saved key is used even if ChatGPT is linked/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect ChatGPT" })).toBeNull();
  });

  it("shows no ChatGPT UI without the Host's prop", () => {
    const html = renderEnglish(createElement(HostKeysPage));
    expect(html).not.toContain("ChatGPT");

    page(undefined, "linked");
    expect(screen.queryByText("Connected via ChatGPT")).toBeNull();
  });
});
