import { createDb } from "@ai-chat/db";
import { session, twoFactor, user } from "@ai-chat/db/schema/auth";
import { createMemorySender, type EmailSender } from "@ai-chat/email";
import { createHmac, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import { type AuthConfig, createAuth } from "../src/index";

const BASE = "http://localhost:3000";
const PASSWORD = "two-factor-password-1";
const env: AuthConfig = {
  BETTER_AUTH_URL: BASE,
  BETTER_AUTH_SECRET: "auth-two-factor-integration-secret-0123",
  APP_NAME: "Acme Chat",
  GITHUB_CLIENT_ID: "test-github-client-id",
  GITHUB_CLIENT_SECRET: "test-github-client-secret",
  GOOGLE_CLIENT_ID: "test-google-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
};
const database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });
const noChatData = { deleteChatData: async () => {} };
// The rate limits would refuse the sign-ins these tests make from one address.
const noLimits = { rateLimit: false };
const logger = { error: () => {} };

afterAll(async () => {
  await database.$client.end();
});

function makeAuth(sender: EmailSender = createMemorySender()) {
  return createAuth(env, database, sender, logger, noChatData, noLimits);
}

type Auth = ReturnType<typeof makeAuth>;

function call(auth: Auth, path: string, body: unknown, cookie?: string) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function getSession(auth: Auth, cookie: string) {
  return auth.handler(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }));
}

/** The cookies a response sets, as one `cookie` header value for the next request. */
function cookiesOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

/** A verified user with a password, as an address no other test uses. */
async function verifiedUser(auth: Auth) {
  const email = `two-factor-${randomUUID()}@example.com`;
  await call(auth, "/sign-up/email", { name: "Two Factor", email, password: PASSWORD });
  await database.update(user).set({ emailVerified: true }).where(eq(user.email, email));
  const [row] = await database.select({ id: user.id }).from(user).where(eq(user.email, email));
  return { id: row!.id, email };
}

async function signIn(auth: Auth, email: string) {
  return call(auth, "/sign-in/email", { email, password: PASSWORD });
}

/** Signs in (no 2FA yet) and returns the session cookie. */
async function signedInCookie(auth: Auth, email: string) {
  return cookiesOf(await signIn(auth, email));
}

/** The RFC 6238 code (SHA-1, 6 digits, 30 seconds) for a base32 secret. */
function totpNow(base32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(
    bits
      .match(/.{8}/g)!
      .map((byte) => Number.parseInt(byte, 2))
      .filter((byte) => !Number.isNaN(byte)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

function secretOf(totpURI: string): string {
  return new URL(totpURI).searchParams.get("secret")!;
}

/** Turns 2FA on for the user whose session cookie is `cookie`. Returns the backup codes. */
async function enableTwoFactor(auth: Auth, cookie: string) {
  const enabled = await call(auth, "/two-factor/enable", { password: PASSWORD }, cookie);
  expect(enabled.status).toBe(200);
  const { totpURI, backupCodes } = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const verified = await call(
    auth,
    "/two-factor/verify-totp",
    { code: totpNow(secretOf(totpURI)) },
    cookie,
  );
  expect(verified.status).toBe(200);
  return { backupCodes, secret: secretOf(totpURI), cookie: cookiesOf(verified) };
}

describe("turning two-factor on", () => {
  it("enables after a confirmed code, signs out the other sessions, and sends the notice", async () => {
    const sender = createMemorySender();
    const auth = makeAuth(sender);
    const person = await verifiedUser(auth);
    const first = await signedInCookie(auth, person.email);
    const other = await signedInCookie(auth, person.email);

    const { cookie } = await enableTwoFactor(auth, first);

    const [row] = await database
      .select({ enabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, person.id));
    expect(row?.enabled).toBe(true);
    expect(await (await getSession(auth, other)).json()).toBeNull();
    expect(await (await getSession(auth, cookie)).json()).toMatchObject({
      user: { id: person.id },
    });
    await vi.waitFor(() =>
      expect(sender.messages).toContainEqual(
        expect.objectContaining({ to: person.email, template: "two-factor-enabled" }),
      ),
    );
  });

  it("refuses the wrong password before any setup is stored", async () => {
    const auth = makeAuth();
    const person = await verifiedUser(auth);
    const cookie = await signedInCookie(auth, person.email);

    const response = await call(
      auth,
      "/two-factor/enable",
      { password: "not-the-password" },
      cookie,
    );

    expect(response.status).toBe(400);
    const rows = await database.select().from(twoFactor).where(eq(twoFactor.userId, person.id));
    expect(rows).toHaveLength(0);
  });
});

describe("signing in with two-factor on", () => {
  it("asks for the second factor, takes a code, and a backup code works only once", async () => {
    const auth = makeAuth();
    const person = await verifiedUser(auth);
    const cookie = await signedInCookie(auth, person.email);
    const { backupCodes, secret } = await enableTwoFactor(auth, cookie);

    const challenged = await signIn(auth, person.email);
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    expect(cookiesOf(challenged)).not.toMatch(/better-auth\.session_token=[^;]/);
    const challenge = cookiesOf(challenged);

    const passed = await call(
      auth,
      "/two-factor/verify-totp",
      { code: totpNow(secret) },
      challenge,
    );
    expect(passed.status).toBe(200);
    expect(cookiesOf(passed)).toMatch(/better-auth\.session_token=[^;]/);

    const backup = backupCodes[0]!;
    const first = await signIn(auth, person.email);
    const firstChallenge = cookiesOf(first);
    const used = await call(
      auth,
      "/two-factor/verify-backup-code",
      { code: backup },
      firstChallenge,
    );
    expect(used.status).toBe(200);

    const second = await signIn(auth, person.email);
    const secondChallenge = cookiesOf(second);
    const reused = await call(
      auth,
      "/two-factor/verify-backup-code",
      { code: backup },
      secondChallenge,
    );
    expect(reused.status).toBe(401);
  });

  it("turning off removes the factor, sends the notice, and leaves other sessions signed in", async () => {
    const sender = createMemorySender();
    const auth = makeAuth(sender);
    const person = await verifiedUser(auth);
    const first = await signedInCookie(auth, person.email);
    const { cookie, secret } = await enableTwoFactor(auth, first);
    // A second device signs in through its own second factor, so it is a session that stays.
    const challenged = await signIn(auth, person.email);
    const other = cookiesOf(
      await call(auth, "/two-factor/verify-totp", { code: totpNow(secret) }, cookiesOf(challenged)),
    );

    const disabled = await call(auth, "/two-factor/disable", { password: PASSWORD }, cookie);

    expect(disabled.status).toBe(200);
    const [row] = await database
      .select({ enabled: user.twoFactorEnabled })
      .from(user)
      .where(eq(user.id, person.id));
    expect(row?.enabled).toBe(false);
    const rows = await database.select().from(twoFactor).where(eq(twoFactor.userId, person.id));
    expect(rows).toHaveLength(0);
    expect(await (await getSession(auth, other)).json()).toMatchObject({
      user: { id: person.id },
    });
    await vi.waitFor(() =>
      expect(sender.messages).toContainEqual(
        expect.objectContaining({ to: person.email, template: "two-factor-disabled" }),
      ),
    );
  });
});

describe("the session rows", () => {
  it("keeps the rotated session when the first code confirms the setup", async () => {
    const auth = makeAuth();
    const person = await verifiedUser(auth);
    const cookie = await signedInCookie(auth, person.email);
    const before = await database
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, person.id));

    await enableTwoFactor(auth, cookie);

    const after = await database
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, person.id));
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });
});
