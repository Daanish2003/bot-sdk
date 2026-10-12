import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

import { hashPassword } from "../src/lib/password";

import { baseURL, e2eDatabaseUrl } from "./env";

export type SeededUser = { id: string; name: string; email: string; password: string };

/** Writes a user with a password into the e2e database, as `/api/sign-up` does. Nobody signs in. */
export async function createUser(): Promise<SeededUser> {
  const name = "E2E User";
  const email = `e2e-${randomUUID()}@example.com`;
  const password = "password1234";
  const prisma = new PrismaClient({ datasourceUrl: e2eDatabaseUrl });
  try {
    const row = await prisma.user.create({
      data: { email, name, passwordHash: await hashPassword(password) },
    });
    return { id: row.id, name, email, password };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A new user, signed in. The page's browser context gets the session cookie that Auth.js's
 * Credentials provider sets, from the same POST the sign-in form makes. The form is skipped, so
 * the test doesn't depend on it.
 */
export async function seedUser(page: Page): Promise<SeededUser> {
  const user = await createUser();
  const { csrfToken } = (await (await page.request.get(`${baseURL}/api/auth/csrf`)).json()) as {
    csrfToken: string;
  };
  const response = await page.request.post(`${baseURL}/api/auth/callback/credentials`, {
    form: { csrfToken, email: user.email, password: user.password, callbackUrl: `${baseURL}/c` },
    maxRedirects: 0,
  });
  const location = response.headers().location ?? "";
  const cookies = await page.context().cookies();
  const signedIn = cookies.some((cookie) => cookie.name === "authjs.session-token");
  if (response.status() !== 302 || location.includes("error") || !signedIn) {
    throw new Error(`Auth.js did not sign the seeded user in (status ${response.status()})`);
  }
  return user;
}
