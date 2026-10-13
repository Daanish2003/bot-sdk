import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const passkey = vi.fn(async (_options?: { autoFill?: boolean }) => ({ error: null }));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ isPending: false }),
    signIn: {
      passkey: (options?: { autoFill?: boolean }) => passkey(options),
      email: vi.fn(),
    },
  },
}));

vi.mock("@/admin/ban", () => ({ suspendedMessage: "This account is suspended." }));

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children }: { children: unknown }) => children,
}));

// A fresh module per test, so the once-per-page-load flag starts clean.
async function loadSignInForm() {
  vi.resetModules();
  return (await import("./sign-in-form")).default;
}

// Lets the async conditional-UI check, and any request it starts, run before we count calls.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const autofillCalls = () => passkey.mock.calls.filter(([options]) => options?.autoFill === true);

describe("SignInForm passkey autofill", () => {
  beforeEach(() => {
    passkey.mockClear();
    navigate.mockClear();
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: { isConditionalMediationAvailable: async () => true },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not start autofill on mount", async () => {
    const SignInForm = await loadSignInForm();
    render(<SignInForm onSwitchToSignUp={() => {}} />);

    await settle();
    expect(autofillCalls()).toHaveLength(0);
  });

  it("starts autofill once, on the first focus of the email field", async () => {
    const SignInForm = await loadSignInForm();
    render(<SignInForm onSwitchToSignUp={() => {}} />);
    const email = screen.getByLabelText("Email");
    await settle();
    expect(autofillCalls()).toHaveLength(0);

    fireEvent.focus(email);
    await waitFor(() => expect(autofillCalls()).toHaveLength(1));

    fireEvent.blur(email);
    fireEvent.focus(email);
    await settle();
    expect(autofillCalls()).toHaveLength(1);
  });

  it("does not start autofill again when the form remounts in the same page load", async () => {
    const SignInForm = await loadSignInForm();
    const first = render(<SignInForm onSwitchToSignUp={() => {}} />);
    fireEvent.focus(screen.getByLabelText("Email"));
    await waitFor(() => expect(autofillCalls()).toHaveLength(1));
    first.unmount();

    render(<SignInForm onSwitchToSignUp={() => {}} />);
    fireEvent.focus(screen.getByLabelText("Email"));
    await settle();
    expect(autofillCalls()).toHaveLength(1);
  });

  it("does not navigate once the form has unmounted with an autofill request pending", async () => {
    const SignInForm = await loadSignInForm();
    let finish!: (value: { error: null }) => void;
    passkey.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const view = render(<SignInForm onSwitchToSignUp={() => {}} />);
    fireEvent.focus(screen.getByLabelText("Email"));
    await waitFor(() => expect(autofillCalls()).toHaveLength(1));

    view.unmount();
    finish({ error: null });
    await settle();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("a plain button sign-in makes exactly one passkey request", async () => {
    const SignInForm = await loadSignInForm();
    render(<SignInForm onSwitchToSignUp={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await settle();
    expect(passkey).toHaveBeenCalledTimes(1);
    expect(passkey).toHaveBeenCalledWith(undefined);
  });
});
