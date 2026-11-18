// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionsHost } from "../src/mcp";
import { HostKeysPage } from "./host-keys-page";
import { providerFor } from "@ai-chat/test-support/fake-dictionary";

afterEach(() => {
  cleanup();
});

type Summary = { key: string; name: string; state: "connected" | "reconnect" | "disconnected" };

const host = (): ConnectionsHost => ({ connect: vi.fn(), disconnect: vi.fn() });

/** The Keys page with `byok` on and the Connections list seeded as `connections`. */
function page(connections: Summary[], connectionsHost: ConnectionsHost = host()) {
  let listState: () => { isInvalidated: boolean } | undefined = () => undefined;
  render(
    providerFor(createElement(HostKeysPage, { connections: connectionsHost }), {
      messages: {},
      seed: (queryClient, client) => {
        queryClient.setQueryData(client.orpc.models.credentials.mode.queryKey(), { byok: true });
        queryClient.setQueryData(client.orpc.models.credentials.list.queryKey(), []);
        queryClient.setQueryData(client.orpc.mcp.listConnections.queryKey(), connections);
        listState = () => queryClient.getQueryState(client.orpc.mcp.listConnections.queryKey());
      },
    }),
  );
  return Object.assign(connectionsHost, { listState: () => listState() });
}

const row = (name: string) => within(screen.getByText(name).closest("li")!);

describe("the Connections section of the Keys page", () => {
  it("is left out when the Host declares no Connections", () => {
    page([]);

    expect(screen.queryByRole("heading", { name: "Connections" })).toBeNull();
  });

  it("shows each Connection's state", () => {
    page([
      { key: "gmail", name: "Gmail", state: "connected" },
      { key: "github", name: "GitHub", state: "reconnect" },
      { key: "calendar", name: "Google Calendar", state: "disconnected" },
    ]);

    expect(screen.getByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(row("Gmail").getByText("Connected")).toBeTruthy();
    expect(row("GitHub").getByText("Reconnect needed")).toBeTruthy();
    expect(row("Google Calendar").getByText("Not connected")).toBeTruthy();
  });

  it("offers Connect for a Connection that isn't connected, which calls the Host's connect", async () => {
    const connections = page([{ key: "github", name: "GitHub", state: "disconnected" }]);

    expect(row("GitHub").queryByRole("button", { name: "Disconnect" })).toBeNull();
    fireEvent.click(row("GitHub").getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(connections.connect).toHaveBeenCalledWith("github"));
    // A connect that finishes in the page refetches the states.
    await waitFor(() => expect(connections.listState()?.isInvalidated).toBe(true));
  });

  it("offers Reconnect for a broken Connection, which runs the Host's connect again", async () => {
    const connections = page([{ key: "github", name: "GitHub", state: "reconnect" }]);

    fireEvent.click(row("GitHub").getByRole("button", { name: "Reconnect" }));

    await waitFor(() => expect(connections.connect).toHaveBeenCalledWith("github"));
  });

  it("offers Disconnect for a connected Connection, which calls the Host's disconnect", async () => {
    const connections = page([{ key: "github", name: "GitHub", state: "connected" }]);

    expect(row("GitHub").queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.click(row("GitHub").getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(connections.disconnect).toHaveBeenCalledWith("github"));
    expect(connections.connect).not.toHaveBeenCalled();
  });
});
