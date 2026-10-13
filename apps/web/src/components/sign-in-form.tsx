import { Button } from "@ai-chat/ui/components/button";
import { Input } from "@ai-chat/ui/components/input";
import { Label } from "@ai-chat/ui/components/label";
import { useForm } from "@tanstack/react-form";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import z from "zod";

import { suspendedMessage } from "@/admin/ban";
import { authClient } from "@/lib/auth-client";

import Loader from "./loader";

// Set once per page load, so a remount of the form does not start another autofill request (#336).
let autofillStarted = false;

export default function SignInForm({ onSwitchToSignUp }: { onSwitchToSignUp: () => void }) {
  const navigate = useNavigate({
    from: "/",
  });
  const { isPending } = authClient.useSession();

  // A banned user is refused with the same one message as on the password path.
  const passkeyFailed = (error: { code?: string; message?: string }) => {
    toast.error(
      error.code === "BANNED_USER"
        ? suspendedMessage
        : error.message || "Could not sign in with a passkey",
    );
  };

  // Conditional UI: where the browser supports it, saved passkeys are offered in the email field's
  // autofill. Choosing one signs in without a password (and without the second factor). The request
  // starts on the email field's first focus, at most once per page load (#336).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const startAutofill = () => {
    if (autofillStarted || !window.PublicKeyCredential?.isConditionalMediationAvailable) return;
    autofillStarted = true;
    void PublicKeyCredential.isConditionalMediationAvailable().then(async (available) => {
      if (!available || !mounted.current) return;
      const { error } = await authClient.signIn.passkey({ autoFill: true });
      if (!mounted.current) return;
      if (error) {
        passkeyFailed(error);
        return;
      }
      navigate({ to: "/c" });
    });
  };

  const passkeySignIn = async () => {
    const { error } = await authClient.signIn.passkey();
    if (error) {
      passkeyFailed(error);
      return;
    }
    navigate({ to: "/c" });
  };

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
    },
    onSubmit: async ({ value }) => {
      await authClient.signIn.email(
        {
          email: value.email,
          password: value.password,
        },
        {
          onSuccess: (context) => {
            // A user with two-factor sign-in gets the code screen, which finishes the sign-in.
            if (context.data?.twoFactorRedirect) {
              navigate({ to: "/two-factor" });
              return;
            }
            navigate({
              to: "/c",
            });
            toast.success("Sign in successful");
          },
          onError: (error) => {
            // A banned user is refused with the same 403 as an unverified one, so the code comes first.
            if (error.error.code === "BANNED_USER") {
              toast.error(suspendedMessage);
              return;
            }
            // Refused until the email is verified (403). Better Auth has sent a fresh link.
            if (error.error.status === 403) {
              navigate({
                to: "/check-email",
                search: { email: value.email, sent: true },
              });
              return;
            }
            toast.error(error.error.message || error.error.statusText);
          },
        },
      );
    },
    validators: {
      onSubmit: z.object({
        email: z.email("Invalid email address"),
        password: z.string().min(8, "Password must be at least 8 characters"),
      }),
    },
  });

  if (isPending) {
    return <Loader />;
  }

  return (
    <div className="mx-auto w-full mt-10 max-w-md p-6">
      <h1 className="mb-6 text-center text-3xl font-bold">Welcome Back</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
        className="space-y-4"
      >
        <div>
          <form.Field name="email">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Email</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  type="email"
                  autoComplete="username webauthn"
                  value={field.state.value}
                  onFocus={startAutofill}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-red-500">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>
        </div>

        <div>
          <form.Field name="password">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>Password</Label>
                <Input
                  id={field.name}
                  name={field.name}
                  type="password"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.map((error) => (
                  <p key={error?.message} className="text-red-500">
                    {error?.message}
                  </p>
                ))}
              </div>
            )}
          </form.Field>
        </div>

        <form.Subscribe
          selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <Button type="submit" className="w-full" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Submitting..." : "Sign In"}
            </Button>
          )}
        </form.Subscribe>
      </form>

      <div className="mt-4">
        <Button type="button" variant="outline" className="w-full" onClick={passkeySignIn}>
          Sign in with a passkey
        </Button>
      </div>

      <div className="mt-4 text-center">
        <Link to="/forgot-password" className="text-sm underline">
          Forgot password?
        </Link>
      </div>

      <div className="mt-4 text-center">
        <Button variant="link" onClick={onSwitchToSignUp}>
          Need an account? Sign Up
        </Button>
      </div>
    </div>
  );
}
