import { Button } from "@ai-chat/ui/components/button";
import { Checkbox } from "@ai-chat/ui/components/checkbox";
import { Input } from "@ai-chat/ui/components/input";
import { Label } from "@ai-chat/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";
import { describeUserAgent } from "@/lib/user-agent";

/** Account: the Profile, Email, Password, Connected accounts and Active sessions sections of settings. */
export function AccountPage() {
  const { data: current } = authClient.useSession();
  if (!current) return null;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-6">
      <h1 className="text-xl font-semibold">Account</h1>
      <ProfileSection name={current.user.name} />
      <EmailSection email={current.user.email} />
      <PasswordSection email={current.user.email} />
      <ConnectedAccountsSection />
      <SessionsSection currentSessionId={current.session.id} />
    </main>
  );
}

function ProfileSection({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  const save = useMutation({
    mutationFn: async (newName: string) => {
      const { error } = await authClient.updateUser({ name: newName });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => toast.success("Name updated"),
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Profile</h2>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(value.trim());
        }}
      >
        <div className="flex-1 space-y-2">
          <Label htmlFor="account-name">Name</Label>
          <Input
            id="account-name"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            maxLength={100}
          />
        </div>
        <Button
          type="submit"
          disabled={save.isPending || value.trim() === "" || value.trim() === name}
        >
          Save name
        </Button>
      </form>
    </section>
  );
}

/** The same answer for a free address and one that already has an account, so the form can't tell them apart. */
function EmailSection({ email }: { email: string }) {
  const [value, setValue] = useState("");
  const request = useMutation({
    mutationFn: async (newEmail: string) => {
      const { error } = await authClient.changeEmail({
        newEmail,
        callbackURL: `${window.location.origin}/email-changed`,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setValue("");
      toast.success("We sent a confirmation to your current address. Open it to continue.");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Email</h2>
      <p className="text-sm text-muted-foreground">Current address: {email}</p>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          request.mutate(value.trim());
        }}
      >
        <div className="flex-1 space-y-2">
          <Label htmlFor="account-new-email">New email</Label>
          <Input
            id="account-new-email"
            type="email"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            maxLength={255}
          />
        </div>
        <Button type="submit" disabled={request.isPending || value.trim() === ""}>
          Change email
        </Button>
      </form>
    </section>
  );
}

const accountsKey = ["account", "accounts"];

function useLinkedAccounts() {
  return useQuery({
    queryKey: accountsKey,
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts();
      if (error) throw new Error(error.message);
      return data;
    },
  });
}

/** Password: a change form for a user with a password. OAuth-only users get a link to set one. */
function PasswordSection({ email }: { email: string }) {
  const accounts = useLinkedAccounts();
  const hasPassword = accounts.data?.some((account) => account.providerId === "credential");

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Password</h2>
      {hasPassword ? (
        <ChangePasswordForm />
      ) : hasPassword === false ? (
        <SetPasswordByEmail email={email} />
      ) : null}
    </section>
  );
}

/**
 * A user who only signs in with GitHub or Google sets a first password through the reset link, so
 * this sends that link. Using it signs out every session, this one included.
 */
function SetPasswordByEmail({ email }: { email: string }) {
  const request = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => toast.success("We sent a link to set a password. Open it to continue."),
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        You sign in with GitHub or Google. To sign in with email too, we'll send a link to set a
        password. Using it signs out all your sessions, so you'll sign in again with the new
        password.
      </p>
      <Button variant="outline" onClick={() => request.mutate()} disabled={request.isPending}>
        Email me a link to set a password
      </Button>
    </div>
  );
}

const socialProviders = [
  { id: "github", label: "GitHub" },
  { id: "google", label: "Google" },
] as const;

const lastSignInMessage =
  "This is your only way to sign in, so it can't be unlinked. Set a password or link another account first.";

/** Connected accounts: link or unlink GitHub and Google. Better Auth refuses to unlink the last sign-in method. */
function ConnectedAccountsSection() {
  const queryClient = useQueryClient();
  const accounts = useLinkedAccounts();
  const rows = accounts.data ?? [];

  const link = useMutation({
    mutationFn: async (provider: (typeof socialProviders)[number]["id"]) => {
      // Better Auth answers with the provider's authorize URL and the browser follows it.
      const { error } = await authClient.linkSocial({
        provider,
        callbackURL: "/settings/account",
      });
      if (error) throw new Error(error.message);
    },
    onError: (error) => toast.error(error.message || "Could not start linking"),
  });

  const unlink = useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await authClient.unlinkAccount({ accountId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Account unlinked");
      queryClient.invalidateQueries({ queryKey: accountsKey });
    },
    onError: (failure: { code?: string; message?: string }) =>
      toast.error(
        failure.code === "FAILED_TO_UNLINK_LAST_ACCOUNT"
          ? lastSignInMessage
          : (failure.message ?? "Could not unlink the account"),
      ),
  });

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Connected accounts</h2>
      <ul aria-label="Connected accounts" className="divide-y overflow-hidden rounded-xl border">
        {socialProviders.map((provider) => {
          const linked = rows.find((row) => row.providerId === provider.id);
          return (
            <li
              key={provider.id}
              className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <span>
                {provider.label}:{" "}
                <span className="text-muted-foreground">{linked ? "Linked" : "Not linked"}</span>
              </span>
              {linked ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rows.length === 1 || unlink.isPending}
                  onClick={() => unlink.mutate(linked.id)}
                >
                  Unlink {provider.label}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={link.isPending}
                  onClick={() => link.mutate(provider.id)}
                >
                  Link {provider.label}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length === 1 ? (
        <p className="text-sm text-muted-foreground">{lastSignInMessage}</p>
      ) : null}
    </section>
  );
}

function ChangePasswordForm() {
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: signOutOthers,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setError(null);
      toast.success("Password changed");
      queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
    },
    onError: (failure: { code?: string; message?: string }) => {
      setError(
        failure.code === "INVALID_PASSWORD"
          ? "Current password is incorrect"
          : (failure.message ?? "Could not change the password"),
      );
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        change.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="account-current-password">Current password</Label>
          <Input
            id="account-current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="account-new-password">New password</Label>
          <Input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="account-sign-out-others"
          checked={signOutOthers}
          onCheckedChange={setSignOutOthers}
        />
        <Label htmlFor="account-sign-out-others">Sign out my other sessions</Label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={change.isPending || currentPassword === "" || newPassword === ""}
      >
        Change password
      </Button>
    </form>
  );
}

function SessionsSection({ currentSessionId }: { currentSessionId: string }) {
  const queryClient = useQueryClient();
  const sessionsKey = ["account", "sessions"];
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: async () => {
      const { data, error } = await authClient.listSessions();
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const signOutOthers = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Other sessions signed out");
      queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Active sessions</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => signOutOthers.mutate()}
          disabled={signOutOthers.isPending}
        >
          Sign out other sessions
        </Button>
      </div>
      {sessions.data ? (
        <ul aria-label="Active sessions" className="divide-y overflow-hidden rounded-xl border">
          {sessions.data.map((session) => (
            <li key={session.id} className="flex flex-col gap-1 p-4 text-sm">
              <span className="font-medium">{describeUserAgent(session.userAgent)}</span>
              <span className="text-muted-foreground">
                {session.id === currentSessionId ? "This device" : "Another device"} · Last used{" "}
                {new Date(session.updatedAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Loading sessions…</p>
      )}
    </section>
  );
}
