import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { navigate, signOut } = vi.hoisted(() => ({ navigate: vi.fn(), signOut: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({ authClient: { signOut } }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import AccountMenu from "./account-menu";

afterEach(() => {
  cleanup();
  navigate.mockClear();
  signOut.mockClear();
});

const open = () => fireEvent.click(screen.getByRole("button", { name: /Ada/ }));

describe("AccountMenu", () => {
  it("offers Keys, Account and Sign out, but not Admin, to a user", () => {
    render(<AccountMenu name="Ada" email="ada@example.com" isAdmin={false} />);
    open();
    expect(screen.getByRole("menuitem", { name: "Keys" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Account" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Admin" })).toBeNull();
  });

  it("offers Admin to an admin", () => {
    render(<AccountMenu name="Ada" email="ada@example.com" isAdmin />);
    open();
    expect(screen.getByRole("menuitem", { name: "Admin" })).toBeTruthy();
  });

  it("signs out, then goes to the login page", () => {
    signOut.mockImplementation(async ({ fetchOptions }) => fetchOptions.onSuccess());
    render(<AccountMenu name="Ada" email="ada@example.com" isAdmin={false} />);
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/login" });
  });
});
