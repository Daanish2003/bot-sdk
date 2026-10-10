import { createDb } from "@ai-chat/db";
import { account, session, user } from "@ai-chat/db/schema/auth";
import { createMemorySender, type EmailSender } from "@ai-chat/email";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import { type AuthConfig, type AuthLogger, createAuth } from "../src/index";

const BASE = "http://localhost:3000";
const env: AuthConfig = {
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "auth-integration-secret-0123456789abcdef",
  APP_NAME: "Acme Chat",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
};
const database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });
const noChatData = { deleteChatData: async () => {} };

afterAll(async () => {
  await database.$client.end();
});

function makeLogger() {
  return { error: vi.fn<AuthLogger["error"]>() } satisfies AuthLogger;
}

function signUp(auth: ReturnType<typeof createAuth>, email: string, password: string) {
  return post(auth, "/sign-up/email", { name: "Someone", email, password });
}

function post(auth: ReturnType<typeof createAuth>, path: string, body: unknown) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
    }),
  );
}

async function userRow(email: string) {
  const rows = await database
    .select({ id: user.id, name: user.name, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email));
  return rows;
}

async function passwordHashOf(userId: string) {
  const [row] = await database
    .select({ password: account.password })
    .from(account)
    .where(eq(account.userId, userId));
  return row?.password;
}

describe("sign-up and email verification", () => {
  it("answers a new and an existing email the same, and leaves the existing account alone", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);

    const fresh = await signUp(auth, "owner@example.com", "owner-password-1");
    const [owner] = await userRow("owner@example.com");
    const ownerHash = await passwordHashOf(owner.id);

    const existing = await post(auth, "/sign-up/email", {
      name: "Intruder",
      email: "owner@example.com",
      password: "intruder-password-1",
    });

    expect(fresh.status).toBe(200);
    expect(existing.status).toBe(fresh.status);
    const freshBody = (await fresh.json()) as Record<string, unknown>;
    const existingBody = (await existing.json()) as Record<string, unknown>;
    expect(Object.keys(existingBody).sort()).toEqual(Object.keys(freshBody).sort());
    expect(existingBody.token).toBeNull();

    const rows = await userRow("owner@example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Someone", emailVerified: false });
    expect(await passwordHashOf(owner.id)).toBe(ownerHash);
  });

  it("refuses sign-in before verification with 403, and sends a fresh link", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);
    await signUp(auth, "waiting@example.com", "waiting-password-1");

    const response = await post(auth, "/sign-in/email", {
      email: "waiting@example.com",
      password: "waiting-password-1",
    });

    expect(response.status).toBe(403);
    await vi.waitFor(() => expect(sender.messages).toHaveLength(2));
    const last = sender.messages.at(-1);
    expect(last).toMatchObject({ to: "waiting@example.com", template: "verify-email" });
    expect(last?.link).toContain("/api/auth/verify-email?token=");
  });

  it("a sender that throws neither fails the request nor goes unlogged", async () => {
    const failing: EmailSender = {
      send: vi.fn(async () => {
        throw new Error("provider is down");
      }),
    };
    const logger = makeLogger();
    const auth = createAuth(env, database, failing, logger, noChatData);

    const response = await signUp(auth, "unlucky@example.com", "unlucky-password-1");

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledTimes(1));
    expect(logger.error.mock.calls[0][0]).toMatchObject({ action: "email.send" });
  });
});

describe("forgotten password", () => {
  const RESET_TO = `${BASE}/reset-password`;

  async function verifiedUser(
    auth: ReturnType<typeof createAuth>,
    email: string,
    password: string,
  ) {
    await signUp(auth, email, password);
    await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
  }

  function requestReset(auth: ReturnType<typeof createAuth>, email: string) {
    return post(auth, "/request-password-reset", { email, redirectTo: RESET_TO });
  }

  function resetMails(sender: { messages: { template: string }[] }) {
    return sender.messages.filter((message) => message.template === "reset-password");
  }

  // The reset link's token, read from the link the sender received.
  function tokenFrom(link: string | undefined) {
    const match = /\/reset-password\/([^?]+)/.exec(link ?? "");
    if (!match) throw new Error(`no reset token in "${link}"`);
    return match[1];
  }

  function resetWith(auth: ReturnType<typeof createAuth>, token: string, newPassword: string) {
    return post(auth, "/reset-password", { token, newPassword });
  }

  it("answers an existing and a missing email the same, and mails only the existing one", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);
    await verifiedUser(auth, "reset-me@example.com", "reset-password-1");

    const existing = await requestReset(auth, "reset-me@example.com");
    const missing = await requestReset(auth, "nobody-here@example.com");

    expect(existing.status).toBe(200);
    expect(missing.status).toBe(existing.status);
    expect(await missing.json()).toEqual(await existing.json());
    await vi.waitFor(() => expect(resetMails(sender)).toHaveLength(1));
    expect(resetMails(sender)[0]).toMatchObject({
      to: "reset-me@example.com",
      template: "reset-password",
    });
  });

  it("a reset token works once; the second use is refused", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);
    await verifiedUser(auth, "once@example.com", "old-password-1");
    await requestReset(auth, "once@example.com");
    await vi.waitFor(() => expect(resetMails(sender)).toHaveLength(1));
    const token = tokenFrom(sender.lastLinkTo("once@example.com"));

    const first = await resetWith(auth, token, "new-password-1");
    const second = await resetWith(auth, token, "newer-password-2");

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    const signIn = await post(auth, "/sign-in/email", {
      email: "once@example.com",
      password: "new-password-1",
    });
    expect(signIn.status).toBe(200);
  });

  it("signs out every other session after a reset, and mails the password-changed notice", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);
    await verifiedUser(auth, "sessions@example.com", "old-password-1");
    const other = await post(auth, "/sign-in/email", {
      email: "sessions@example.com",
      password: "old-password-1",
    });
    const cookie = other.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const session = (headers: Record<string, string>) =>
      auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers }));
    expect(await (await session({ cookie })).json()).toMatchObject({
      user: { email: "sessions@example.com" },
    });

    await requestReset(auth, "sessions@example.com");
    await vi.waitFor(() => expect(resetMails(sender)).toHaveLength(1));
    const token = tokenFrom(sender.lastLinkTo("sessions@example.com"));
    await resetWith(auth, token, "new-password-1");

    expect(await (await session({ cookie })).json()).toBeNull();
    await vi.waitFor(() =>
      expect(sender.messages.map((message) => message.template)).toContain("password-changed"),
    );
  });
});

describe("change password", () => {
  async function signedInCookie(
    auth: ReturnType<typeof createAuth>,
    email: string,
    password: string,
  ) {
    await signUp(auth, email, password);
    await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
    const signIn = await post(auth, "/sign-in/email", { email, password });
    return signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }

  function changePassword(
    auth: ReturnType<typeof createAuth>,
    cookie: string,
    currentPassword: string,
    newPassword: string,
  ) {
    return auth.handler(
      new Request(`${BASE}/api/auth/change-password`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    );
  }

  it("mails the password-changed notice once the password is changed", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);
    const cookie = await signedInCookie(auth, "changer@example.com", "old-password-1");

    const changed = await changePassword(auth, cookie, "old-password-1", "new-password-1");

    expect(changed.status).toBe(200);
    await vi.waitFor(() =>
      expect(sender.messages).toContainEqual(
        expect.objectContaining({ to: "changer@example.com", template: "password-changed" }),
      ),
    );
  });

  it("refuses a wrong current password and mails no notice", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);
    const cookie = await signedInCookie(auth, "guesser@example.com", "old-password-1");

    const refused = await changePassword(auth, cookie, "not-the-password-1", "new-password-1");

    expect(refused.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sender.messages.map((message) => message.template)).not.toContain("password-changed");
  });
});

describe("change email", () => {
  // The database persists between runs, so every run uses its own addresses.
  const run = randomUUID().slice(0, 8);
  const OLD = `old-address-${run}@example.com`;
  const NEW = `new-address-${run}@example.com`;
  const TAKEN = `taken-${run}@example.com`;
  const REQUESTER = `requester-${run}@example.com`;
  const FREE = `free-${run}@example.com`;
  const RETURN_TO = `${BASE}/email-changed`;

  async function signedIn(auth: ReturnType<typeof createAuth>, email: string) {
    await signUp(auth, email, "mover-password-1");
    await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
    const response = await post(auth, "/sign-in/email", { email, password: "mover-password-1" });
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }

  function requestChange(auth: ReturnType<typeof createAuth>, cookie: string, newEmail: string) {
    return auth.handler(
      new Request(`${BASE}/api/auth/change-email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify({ newEmail, callbackURL: RETURN_TO }),
      }),
    );
  }

  // Opens an emailed link with the given session, the way a browser would.
  function open(auth: ReturnType<typeof createAuth>, link: string | undefined, cookie: string) {
    return auth.handler(new Request(link ?? "", { headers: { cookie } }));
  }

  function changeMails(sender: { messages: { template: string; to: string }[] }) {
    return sender.messages.filter(
      (message) =>
        message.template.startsWith("change-email") || message.template === "verify-new-email",
    );
  }

  it("sends the confirmation to the current address, and changes nothing until the new one is verified", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);
    const cookie = await signedIn(auth, OLD);

    const response = await requestChange(auth, cookie, NEW);

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(changeMails(sender)).toHaveLength(1));
    expect(changeMails(sender)[0]).toMatchObject({ to: OLD, template: "change-email-confirm" });
    expect(await userRow(OLD)).toHaveLength(1);
    expect(await userRow(NEW)).toHaveLength(0);

    const confirmed = await open(auth, sender.lastLinkTo(OLD), cookie);
    expect(confirmed.status).toBe(302);
    await vi.waitFor(() => expect(changeMails(sender)).toHaveLength(2));
    expect(changeMails(sender)[1]).toMatchObject({ to: NEW, template: "verify-new-email" });
    expect(await userRow(OLD)).toHaveLength(1);
    expect(await userRow(NEW)).toHaveLength(0);

    const verified = await open(auth, sender.lastLinkTo(NEW), cookie);
    expect(verified.status).toBe(302);
    expect(await userRow(NEW)).toHaveLength(1);
    expect(await userRow(OLD)).toHaveLength(0);
  });

  it("answers an address that already has an account the same as a free one, and changes no account", async () => {
    const sender = createMemorySender();
    const auth = createAuth(env, database, sender, makeLogger(), noChatData);
    await signUp(auth, TAKEN, "taken-password-1");
    const cookie = await signedIn(auth, REQUESTER);

    const taken = await requestChange(auth, cookie, TAKEN);
    const free = await requestChange(auth, cookie, FREE);

    expect(taken.status).toBe(free.status);
    expect(await taken.json()).toEqual(await free.json());
    await vi.waitFor(() => expect(changeMails(sender)).toHaveLength(1));
    expect(changeMails(sender)).toEqual([expect.objectContaining({ to: REQUESTER })]);
    expect(await userRow(REQUESTER)).toHaveLength(1);
    expect(await userRow(TAKEN)).toHaveLength(1);
  });
});

describe("social sign-in", () => {
  it.each([
    ["github", "https://github.com/login/oauth/authorize", "test-github-client-id"],
    [
      "google",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "test-google-client-id.apps.googleusercontent.com",
    ],
  ])(
    "starts %s at its authorize URL with the configured client and callback",
    async (provider, authorize, clientId) => {
      const auth = createAuth(env, database, createMemorySender(), makeLogger(), noChatData);
      const response = await post(auth, "/sign-in/social", { provider, callbackURL: "/c" });
      const { url } = (await response.json()) as { url: string };

      const start = new URL(url);
      expect(`${start.origin}${start.pathname}`).toBe(authorize);
      expect(start.searchParams.get("client_id")).toBe(clientId);
      expect(start.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/${provider}`);
    },
  );
});

describe("account deletion", () => {
  const run = randomUUID().slice(0, 8);
  const LEAVER = `leaver-${run}@example.com`;
  const RETRIED = `retried-${run}@example.com`;
  const CALLBACK = `${BASE}/login`;

  async function signedInCookie(auth: ReturnType<typeof createAuth>, email: string) {
    await signUp(auth, email, "leaver-password-1");
    await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
    const response = await post(auth, "/sign-in/email", { email, password: "leaver-password-1" });
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }

  function requestDeletion(auth: ReturnType<typeof createAuth>, cookie: string) {
    return auth.handler(
      new Request(`${BASE}/api/auth/delete-user`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify({ callbackURL: CALLBACK }),
      }),
    );
  }

  // The link of the newest deletion confirmation the sender received.
  async function confirmationLink(sender: ReturnType<typeof createMemorySender>, count: number) {
    await vi.waitFor(() =>
      expect(sender.messages.filter((m) => m.template === "delete-account-confirm")).toHaveLength(
        count,
      ),
    );
    return (
      sender.messages.filter((m) => m.template === "delete-account-confirm").at(-1)?.link ?? ""
    );
  }

  function follow(auth: ReturnType<typeof createAuth>, link: string, cookie: string) {
    return auth.handler(new Request(link, { headers: { cookie } }));
  }

  async function rowsFor(email: string) {
    const [row] = await database.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (!row) return { user: 0, sessions: 0, accounts: 0 };
    const sessions = await database.select().from(session).where(eq(session.userId, row.id));
    const accounts = await database.select().from(account).where(eq(account.userId, row.id));
    return { user: 1, sessions: sessions.length, accounts: accounts.length, id: row.id };
  }

  it("the emailed link calls the hook with the user's id, then removes the user, sessions and accounts", async () => {
    const sender = createMemorySender();
    const deleteChatData = vi.fn(async (_userId: string) => {});
    const auth = createAuth(env, database, sender, makeLogger(), { deleteChatData });
    const cookie = await signedInCookie(auth, LEAVER);
    const before = await rowsFor(LEAVER);
    expect(before).toMatchObject({ user: 1, sessions: 1, accounts: 1 });

    const request = await requestDeletion(auth, cookie);
    expect(request.status).toBe(200);
    const link = await confirmationLink(sender, 1);
    expect(link).toContain("/api/auth/delete-user/callback?token=");

    const confirmed = await follow(auth, link, cookie);
    expect(confirmed.status).toBeLessThan(400);
    expect(deleteChatData).toHaveBeenCalledTimes(1);
    expect(deleteChatData).toHaveBeenCalledWith(before.id);
    expect(await rowsFor(LEAVER)).toEqual({ user: 0, sessions: 0, accounts: 0 });
    await vi.waitFor(() =>
      expect(sender.messages.map((m) => m.template)).toContain("account-deleted"),
    );
  });

  it("a hook that throws aborts the delete with the user still there, and a new request retries it", async () => {
    const sender = createMemorySender();
    const deleteChatData = vi
      .fn<(userId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("chat store is down"))
      .mockResolvedValue(undefined);
    const auth = createAuth(env, database, sender, makeLogger(), { deleteChatData });
    const cookie = await signedInCookie(auth, RETRIED);

    await requestDeletion(auth, cookie);
    const failed = await follow(auth, await confirmationLink(sender, 1), cookie);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await rowsFor(RETRIED)).toMatchObject({ user: 1, sessions: 1, accounts: 1 });
    expect(sender.messages.map((m) => m.template)).not.toContain("account-deleted");

    await requestDeletion(auth, cookie);
    await follow(auth, await confirmationLink(sender, 2), cookie);
    expect(deleteChatData).toHaveBeenCalledTimes(2);
    expect(await rowsFor(RETRIED)).toEqual({ user: 0, sessions: 0, accounts: 0 });
  });
});

describe("connected accounts", () => {
  // The sign-in cookie for a verified user, with a credential account and optionally a GitHub one.
  async function signedInWith(
    auth: ReturnType<typeof createAuth>,
    email: string,
    withGitHub: boolean,
  ) {
    await signUp(auth, email, "linker-password-1");
    await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
    const [owner] = await userRow(email);
    if (withGitHub) {
      const now = new Date();
      await database.insert(account).values({
        id: randomUUID(),
        accountId: `github-${randomUUID()}`,
        providerId: "github",
        userId: owner.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    const response = await post(auth, "/sign-in/email", { email, password: "linker-password-1" });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { cookie, userId: owner.id };
  }

  async function accountsOf(userId: string) {
    return database
      .select({ id: account.id, providerId: account.providerId })
      .from(account)
      .where(eq(account.userId, userId));
  }

  function unlink(auth: ReturnType<typeof createAuth>, cookie: string, accountId: string) {
    return auth.handler(
      new Request(`${BASE}/api/auth/unlink-account`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify({ accountId }),
      }),
    );
  }

  it("refuses to unlink the only sign-in method", async () => {
    const auth = createAuth(env, database, createMemorySender(), makeLogger(), noChatData);
    const { cookie, userId } = await signedInWith(auth, `only-${randomUUID()}@example.com`, false);
    const [credential] = await accountsOf(userId);

    const refused = await unlink(auth, cookie, credential.id);

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "FAILED_TO_UNLINK_LAST_ACCOUNT" });
    expect(await accountsOf(userId)).toHaveLength(1);
  });

  it("unlinks one of two sign-in methods and keeps the other", async () => {
    const auth = createAuth(env, database, createMemorySender(), makeLogger(), noChatData);
    const { cookie, userId } = await signedInWith(auth, `two-${randomUUID()}@example.com`, true);
    const accounts = await accountsOf(userId);
    const github = accounts.find((row) => row.providerId === "github");

    const unlinked = await unlink(auth, cookie, github?.id ?? "");

    expect(unlinked.status).toBe(200);
    expect(await accountsOf(userId)).toEqual([
      expect.objectContaining({ providerId: "credential" }),
    ]);
  });
});
