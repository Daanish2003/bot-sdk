import { randomBytes, randomUUID } from "node:crypto";

import { createDb } from "@ai-chat/db";
import { account, session, twoFactor, user } from "@ai-chat/db/schema/auth";
import type { Page } from "@playwright/test";
import { hashPassword, makeSignature, symmetricEncrypt } from "better-auth/crypto";

import { e2eDatabaseUrl } from "./database.ts";
import { serverEnv } from "./env.ts";

/** Better Auth's session cookie name, with its defaults (no `__Secure-` prefix over http). */
const sessionCookieName = "better-auth.session_token";
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export type SeededUser = {
  id: string;
  name: string;
  email: string;
  password: string;
  /** With `twoFactor`: the TOTP key (its bytes are the HMAC key) and the ten backup codes. */
  totpSecret?: string;
  backupCodes?: string[];
};

/**
 * Writes a verified user with a password, and a session for it, straight into the e2e database,
 * then sets the session cookie on `page` the way Better Auth signs it. Every call is a new user,
 * so no test waits on email or on the sign-up rate limit. With `password: false` the user has no
 * credential account (as if they signed up with GitHub or Google); `password` is then unusable.
 * `linked` adds a provider account row for each named provider (a linked GitHub or Google).
 * `twoFactor` turns on two-factor sign-in with a known secret and ten backup codes, stored the way
 * Better Auth stores them, so a test can compute the codes (see `totp.ts`).
 */
export async function seedUser(
  page: Page,
  options: { password?: boolean; linked?: ("github" | "google")[]; twoFactor?: boolean } = {},
): Promise<SeededUser> {
  const seeded: SeededUser = {
    id: randomUUID(),
    name: "E2E User",
    email: `e2e-${randomUUID()}@example.com`,
    password: "password1234",
  };
  const now = new Date();
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.insert(user).values({
      id: seeded.id,
      name: seeded.name,
      email: seeded.email,
      emailVerified: true,
      twoFactorEnabled: options.twoFactor === true,
      createdAt: now,
      updatedAt: now,
    });
    if (options.password !== false) {
      await db.insert(account).values({
        id: randomUUID(),
        accountId: seeded.id,
        providerId: "credential",
        userId: seeded.id,
        password: await hashPassword(seeded.password),
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const providerId of options.linked ?? []) {
      await db.insert(account).values({
        id: randomUUID(),
        accountId: `${providerId}-${seeded.id}`,
        providerId,
        userId: seeded.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (options.twoFactor) {
      const totpSecret = randomBytes(20).toString("base64url");
      const codes = Array.from({ length: 10 }, () => randomBytes(5).toString("hex"));
      const secret = serverEnv.BETTER_AUTH_SECRET;
      await db.insert(twoFactor).values({
        id: randomUUID(),
        userId: seeded.id,
        secret: await symmetricEncrypt({ key: secret, data: totpSecret }),
        backupCodes: await symmetricEncrypt({ key: secret, data: JSON.stringify(codes) }),
        verified: true,
      });
      seeded.totpSecret = totpSecret;
      seeded.backupCodes = codes;
    }
  } finally {
    await db.$client.end();
  }
  await seedSession(page, seeded.id);
  return seeded;
}

/**
 * Writes a session for an existing user and sets its cookie on `page`'s browser context, so a
 * second device (another context) can be signed in as the same user.
 */
export async function seedSession(page: Page, userId: string) {
  const token = randomBytes(24).toString("base64url");
  const now = new Date();
  const db = createDb({ DATABASE_URL: e2eDatabaseUrl() });
  try {
    await db.insert(session).values({
      id: randomUUID(),
      token,
      userId,
      expiresAt: new Date(now.getTime() + sessionLifetimeMs),
      createdAt: now,
      updatedAt: now,
    });
  } finally {
    await db.$client.end();
  }

  const signedToken = `${token}.${await makeSignature(token, serverEnv.BETTER_AUTH_SECRET)}`;
  await page.context().addCookies([
    {
      name: sessionCookieName,
      value: signedToken,
      url: serverEnv.BETTER_AUTH_URL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
