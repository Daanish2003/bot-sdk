import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { listAccounts } = vi.hoisted(() => ({
  listAccounts: vi.fn<() => Promise<{ data: { id: string; providerId: string }[]; error: null }>>(),
}));

vi.mock("@/lib/auth-client", () => ({ authClient: { listAccounts } }));

import { ConnectedAccountsSection } from "./account-page";

afterEach(() => {
  cleanup();
  listAccounts.mockReset();
});

function section(providerIds: string[]) {
  listAccounts.mockResolvedValue({
    data: providerIds.map((providerId, index) => ({ id: `a${index}`, providerId })),
    error: null,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectedAccountsSection />
    </QueryClientProvider>,
  );
}

const unlinkGithub = () => screen.findByRole("button", { name: "Unlink GitHub" });

describe("ConnectedAccountsSection", () => {
  it("keeps the only sign-in method linked, whatever Connections the user has", async () => {
    section(["github", "github-connection", "gmail", "google-calendar", "chatgpt"]);

    expect((await unlinkGithub()).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/This is your only way to sign in/)).toBeTruthy();
  });

  it("offers to unlink GitHub while another sign-in method is left", async () => {
    section(["github", "credential"]);

    expect((await unlinkGithub()).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/This is your only way to sign in/)).toBeNull();
  });
});
