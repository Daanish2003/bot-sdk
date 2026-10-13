import { Button } from "@ai-chat/ui/components/button";
import { Checkbox } from "@ai-chat/ui/components/checkbox";
import { Input } from "@ai-chat/ui/components/input";
import { Label } from "@ai-chat/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";
import { describeUserAgent } from "@/lib/user-agent";

/** Account: the Profile, Email, Password, Connected accounts, Active sessions and Danger zone sections of settings. */
export function AccountPage() {
  const { data: current } = authClient.useSession();
  if (!current) return null;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-6">
      <h1 className="text-xl font-semibold">Account</h1>
      <ProfileSection name={current.user.name} />
      <EmailSection email={current.user.email} />
      <PasswordSection email={current.user.email} />
      <TwoFactorSection />
      <PasskeysSection />
      <ConnectedAccountsSection />
      <SessionsSection currentSessionId={current.session.id} />
      <DangerSection email={current.user.email} />
    </main>
  );
}

/** Danger zone: deleting the account is confirmed by a link to the account's email, and says so. */
function DangerSection({ email }: { email: string }) {
  const request = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.deleteUser({
        callbackURL: `${window.location.origin}/login`,
      });
      if (error) throw new Error(error.message);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <section className="space-y-3 rounded-md border border-destructive/50 p-4">
      <h2 className="text-sm font-medium text-destructive">Danger zone</h2>
      <p className="text-sm text-muted-foreground">
        Deleting your account removes your Conversations, Messages, Attachments, Shared links,
        Provider credentials, Tool credentials and settings at once. This cannot be undone.
      </p>
      {request.isSuccess ? (
        <p className="text-sm">
          We sent a confirmation link to <strong>{email}</strong>. Open it to delete your account.
        </p>
      ) : (
        <Button variant="destructive" disabled={request.isPending} onClick={() => request.mutate()}>
          Delete account
        </Button>
      )}
    </section>
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

type TotpSetup = { secret: string; totpURI: string; backupCodes: string[] };

function secretOf(totpURI: string) {
  return new URL(totpURI).searchParams.get("secret") ?? "";
}

/**
 * Two-factor authentication (spec #277). Turning it on takes the password, then a code from the
 * authenticator that proves the setup works; the backup codes come with that. Once on, the backup
 * codes can be regenerated and 2FA turned off, each behind the password. An OAuth-only user has no
 * password to confirm, so this says what unlocks it instead.
 */
function TwoFactorSection() {
  const { data: current } = authClient.useSession();
  const accounts = useLinkedAccounts();
  const hasPassword = accounts.data?.some((account) => account.providerId === "credential");
  const enabled = current?.user.twoFactorEnabled === true;
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  // The codes shown once, after a setup or a regeneration.
  const [codes, setCodes] = useState<string[] | null>(null);

  if (codes) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Backup codes</h2>
        <BackupCodes codes={codes} onDone={() => setCodes(null)} />
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Two-factor authentication</h2>
      {hasPassword === false ? (
        <p className="text-sm text-muted-foreground">
          You sign in with GitHub or Google, which secures your sign-in. Set a password to unlock
          two-factor authentication.
        </p>
      ) : hasPassword === undefined ? null : enabled ? (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Two-factor authentication is on. Signing in asks for a code from your authenticator app.
          </p>
          <PasswordForm
            id="two-factor-regenerate-password"
            submitLabel="Regenerate backup codes"
            run={async (password) => {
              const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
              if (error) throw error;
              setCodes(data.backupCodes);
            }}
          />
          <PasswordForm
            id="two-factor-disable-password"
            submitLabel="Turn off"
            run={async (password) => {
              const { error } = await authClient.twoFactor.disable({ password });
              if (error) throw error;
              toast.success("Two-factor authentication is off");
            }}
          />
        </div>
      ) : setup ? (
        <VerifySetup
          setup={setup}
          onCancel={() => setSetup(null)}
          onVerified={() => {
            setSetup(null);
            setCodes(setup.backupCodes);
          }}
        />
      ) : (
        <EnableStart
          onSetup={(next) => {
            setSetup(next);
          }}
        />
      )}
    </section>
  );
}

function EnableStart({ onSetup }: { onSetup: (setup: TotpSetup) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Turn on two-factor authentication
      </Button>
    );
  }
  return (
    <PasswordForm
      id="two-factor-enable-password"
      submitLabel="Continue"
      run={async (password) => {
        const { data, error } = await authClient.twoFactor.enable({ password });
        if (error) throw error;
        if (data.method !== "totp") throw new Error("Could not start two-factor setup");
        onSetup({
          secret: secretOf(data.totpURI),
          totpURI: data.totpURI,
          backupCodes: data.backupCodes,
        });
      }}
    />
  );
}

/** The secret as text, and a link that opens it in an authenticator app. A code confirms it. */
function VerifySetup({
  setup,
  onVerified,
  onCancel,
}: {
  setup: TotpSetup;
  onVerified: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const verify = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (error) throw new Error(error.message ?? "That code didn't work");
    },
    onSuccess: () => {
      toast.success("Two-factor authentication is on");
      onVerified();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Add this account to an authenticator app, then enter the 6-digit code it shows.
      </p>
      <p className="text-sm">
        Setup key: <code className="break-all font-mono">{setup.secret}</code>
      </p>
      <a href={setup.totpURI} className="text-sm underline">
        Open in an authenticator app
      </a>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          verify.mutate();
        }}
      >
        <div className="flex-1 space-y-2">
          <Label htmlFor="two-factor-setup-code">Authentication code</Label>
          <Input
            id="two-factor-setup-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={verify.isPending || code.trim() === ""}>
          Confirm
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </form>
    </div>
  );
}

/** A password field and one button. `run` throws the Better Auth error, which is shown by its code. */
function PasswordForm({
  id,
  submitLabel,
  run,
}: {
  id: string;
  submitLabel: string;
  run: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: () => run(password),
    onSuccess: () => {
      setPassword("");
      setError(null);
    },
    onError: (failure: { code?: string; message?: string }) =>
      setError(
        failure.code === "INVALID_PASSWORD"
          ? "Password is incorrect"
          : (failure.message ?? "Something went wrong"),
      ),
  });

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate();
      }}
    >
      <div className="flex-1 space-y-2">
        <Label htmlFor={id}>Password</Label>
        <Input
          id={id}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      <Button type="submit" variant="outline" disabled={submit.isPending || password === ""}>
        {submitLabel}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n");
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Each code works once, in place of an authenticator code. Keep them somewhere safe.
      </p>
      <ul aria-label="Backup codes" className="grid grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => toast.success("Backup codes copied"),
              () => toast.error("Could not copy the codes"),
            )
          }
        >
          Copy backup codes
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = "backup-codes.txt";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Download backup codes
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** Passkeys: add one (the browser prompt, then a name), rename or delete. Adding needs a session from the last day. */
function PasskeysSection() {
  const passkeys = authClient.useListPasskeys();
  const rows = passkeys.data ?? [];
  // The passkey just added, named in the field below the list.
  const [naming, setNaming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: async () => {
      const { data, error } = await authClient.passkey.addPasskey();
      if (error) throw error;
      return data;
    },
    onSuccess: (passkey) => {
      setError(null);
      setName("");
      setNaming(passkey.id);
    },
    onError: (failure: { code?: string; message?: string }) =>
      setError(
        failure.code === "SESSION_NOT_FRESH"
          ? "Sign in again to add a passkey."
          : (failure.message ?? "Could not add the passkey"),
      ),
  });

  const save = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await authClient.$fetch("/passkey/update-passkey", {
        method: "POST",
        body: { id, name: name.trim() },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setNaming(null);
      setRenaming(null);
      setName("");
      passkeys.refetch();
    },
    onError: (failure: { message?: string }) =>
      toast.error(failure.message ?? "Could not rename the passkey"),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await authClient.$fetch("/passkey/delete-passkey", {
        method: "POST",
        body: { id },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Passkey deleted");
      passkeys.refetch();
    },
    onError: (failure: { message?: string }) =>
      toast.error(failure.message ?? "Could not delete the passkey"),
  });

  const editingId = naming ?? renaming;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Passkeys</h2>
      <p className="text-sm text-muted-foreground">
        Passkeys let you sign in without a password, using this device&apos;s screen lock.
      </p>
      {rows.length > 0 ? (
        <ul aria-label="Passkeys" className="divide-y overflow-hidden rounded-xl border">
          {rows.map((passkey) => (
            <li
              key={passkey.id}
              className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              {editingId === passkey.id ? (
                <form
                  className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-end"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save.mutate(passkey.id);
                  }}
                >
                  <div className="flex-1 space-y-2">
                    <Label htmlFor="passkey-name">Passkey name</Label>
                    <Input
                      id="passkey-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={save.isPending || name.trim() === ""}
                  >
                    Save name
                  </Button>
                </form>
              ) : (
                <>
                  <span className="flex flex-col">
                    <span>{passkey.name || "Unnamed passkey"}</span>
                    <span className="text-muted-foreground">
                      Added {new Date(passkey.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Rename ${passkey.name || "Unnamed passkey"}`}
                      onClick={() => {
                        setRenaming(passkey.id);
                        setName(passkey.name ?? "");
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Delete ${passkey.name || "Unnamed passkey"}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(passkey.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="outline" disabled={add.isPending} onClick={() => add.mutate()}>
        Add passkey
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
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
